import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import process from "node:process";
import { nanoid, customAlphabet } from 'nanoid'
import { formatDistanceToNowStrict } from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type Block = {
  previous: string;
  pseudonym: string;
  nonce: string;
  sha256: string;
  difficulty: number;
}

type WorkerData = {
  workerId: [number, number];
  pseudonym: string;
  difficulty: number;
  previous: string;
  updateInterval: number;
  method: 'random' | 'sequential' | 'random-number';
}

function worker(data: WorkerData) {
  const { pseudonym, updateInterval, method, workerId } = data;
  let bestDifficulty = workerData.difficulty;
  let previousHash = workerData.previous
  let iteration = 1;
  let lastUpdate = Date.now();
  const randNum = customAlphabet('1234567890')

  parentPort?.on("HASH-UPDATE", (data) => {
    previousHash = data.hash;
    bestDifficulty = data.difficulty;
  });

  while (true) {
    // Handle the different methods
    let nonce: string;

    if (method === "random") {
      nonce = nanoid();
    } else if (method === "random-number") {
      nonce = randNum();
    } else {
      nonce = workerId[0] + (iteration * workerId[1]).toString();
    }

    const raw = `${previousHash ?? ''}${pseudonym}${nonce}`;
    const sha = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const bin = BigInt("0x" + sha).toString(2).padStart(256, "0");
    const difficulty = bin.indexOf("1")

    if (difficulty > bestDifficulty) {
      parentPort?.postMessage({
        type: "UPDATE",
        block: {
          previous: previousHash,
          pseudonym,
          nonce,
          sha256: sha,
          difficulty
        } as Block
      });
      previousHash = sha;
      bestDifficulty = difficulty;
    }

    // Update every updateInterval milliseconds
    if (Date.now() - lastUpdate > (updateInterval * 0.95)) {
      parentPort?.postMessage({ type: "INTERVAL-UPDATE", count: iteration });
      lastUpdate = Date.now();
    }

    iteration++;
  }
}

if (!isMainThread) {
  worker(workerData);
} else {
  const argv = yargs(hideBin(process.argv))
    .strict()
    .options({
      "pseudonym": {
        alias: "p",
        type: "string",
        description: "Pseudonym to use in the hash",
        demandOption: true
      },
      "hash": {
        alias: "h",
        type: "string",
        description: "The previous hash value",
        default: null,
        demandOption: true
      },
      "threads": {
        alias: "t",
        type: "number",
        description: "Number of threads to use",
        default: cpus().length,
      },
      "max-difficulty": {
        alias: "d",
        type: "number",
        description: "The maximum difficulty to reach",
        default: Infinity
      },
      "update-interval": {
        alias: "u",
        type: "number",
        description: "Interval in seconds to update the log",
        default: 60,
      },
      "method": {
        alias: "m",
        choices: ["random", "sequential", "random-number", "combined"],
        description: "The method to use for hashing",
        default: "random",
        
      }
    })
    .usage("Usage: miner [options]")
    .example("miner -p 'Alice' -d 20 -t 4", "Start mining with 4 threads and a difficulty of 20")
    .help()
    .parseSync();

  const THREAD_COUNT = Math.max(1, argv.threads);
  const UPDATE_INTERVAL = argv['update-interval'] * 1000;
  const FILE_NAME = `miner-${argv.pseudonym}-submission.log`;
  const TOYCHAIN_URL = "https://www.cs.kent.ac.uk/people/staff/sb2213/toychain_comp6575_2425_a1/toy-chain.php"

  const update_log = (message: string) => {
    writeFileSync(FILE_NAME, message + '\n', { flag: 'a' });
  }

  const start = Date.now();
  let hashCount = 0;
  let blockCount = 0;
  let lastBlock = {
    previous: null as string | null,
    difficulty: BigInt("0x" + argv.hash).toString(2).padStart(256, "0").indexOf("1"),
    nonce: "",
    sha256: argv.hash,
    pseudonym: argv.pseudonym
  } as Block;
  const workers: Worker[] = [];
  const startingDifficulty = lastBlock.difficulty + 1;

  // Wipe the file
  if (!existsSync(FILE_NAME)) {
    writeFileSync(FILE_NAME, ''); // Wipe the file
    update_log(argv.pseudonym); // Push the initial pseudonym
  } else {
    const data = readFileSync(FILE_NAME, 'utf-8').split('\n').filter((line) => line.trim() !== '');
    // Get the line count and minus 1
    const lastLine = data[data.length - 1];
    const lastNonce = lastLine.split(argv.pseudonym)[1];
    lastBlock.nonce = lastNonce;
    lastBlock.previous = data[data.length - 2];
    blockCount = data.length - 1;
  }

  console.log(`Starting miner with ${THREAD_COUNT} threads and a difficulty of ${startingDifficulty}. Using method: ${argv.method}.\n`);

  for (let i = 1; i < THREAD_COUNT; i++) {
    let method = argv.method;
    if (argv.method === "combined") {
      method = Math.floor(THREAD_COUNT / 2) < i ? "random" : "sequential";
    }

    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        workerId: [i, THREAD_COUNT],
        previous: argv.hash,
        difficulty: (startingDifficulty),
        pseudonym: argv.pseudonym,
        updateInterval: UPDATE_INTERVAL,
        method,
      } as WorkerData,
    });

    console.log(`Started worker ${i} with method ${method}.`);

    worker.on("message", async (data: { type: string, block: Block, count: number }) => {
      if (data?.type === "INTERVAL-UPDATE") {
        hashCount += data.count;
      } else if (data?.type === "UPDATE") {
        const block = data.block;
        if (block.difficulty > lastBlock.difficulty) {
          await addBlock(block);
          blockCount++;
          if (block.difficulty >= (argv['max-difficulty'])) {
            console.log(`Required difficulty obtained! Time taken: ${formatDistanceToNowStrict(start)}. Total hashes computed: ${hashCount.toLocaleString()}, total blocks submitted: ${blockCount}.\n Available @ ${TOYCHAIN_URL}`);
            process.exit(0); // Stop all processes early
          }
        }
      }
    });

    worker.on("error", (error) => {
      console.error(error);
    });

    workers.push(worker);
  }

  setInterval(() => {
    const now = new Date(Date.now())
    console.log(`[${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB')}] Hashes: ${hashCount.toLocaleString()} | Blocks: ${blockCount}`);
  }, UPDATE_INTERVAL);

  async function addBlock(block: Block) {
    const formData = new FormData();
    formData.append("inputPreviousHash", block.previous.trim());
    formData.append("inputMiner", block.pseudonym.trim());
    formData.append("inputNonce", block.nonce.trim());
    formData.append("submit-block", "Submit New Block");

    try {
      const response = await fetch(TOYCHAIN_URL, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.text();

      const message = data.match(/<h3>(.*?)<\/h3>/)?.entries()

      if (data?.includes("Congratulations")) {
        // Update the hash
        lastBlock = block;
        update_log(`${block.previous}${block.pseudonym}${block.nonce}`);
        console.log(`Block submitted with difficulty ${block.difficulty}.`);
        return Promise.all(workers.map((worker) => worker.postMessage({ type: "BLOCK-UPDATE", block })));
      } else {
        // get the message containing sorry
        const msg = message?.filter((m) => m.includes("Sorry"));
        throw new Error(`Block submission failed. (${msg})`);
      }
    } catch (error) {
      console.error("Error submitting hash: ", error);
    }
  }

}