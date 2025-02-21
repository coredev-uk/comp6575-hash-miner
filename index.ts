import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import process from "node:process";
import { nanoid } from 'nanoid'
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
  pseudonym: string;
  difficulty: number;
  previous: string;
  updateInterval: number;
}

function worker(data: WorkerData) {
  const { pseudonym, updateInterval } = data;
  let bestDifficulty = workerData.difficulty;
  let previousHash = workerData.previous
  let count = 0;
  let lastUpdate = Date.now();

  parentPort?.on("HASH-UPDATE", (data) => {
    previousHash = data.hash;
    bestDifficulty = data.difficulty;
  });

  while (true) {
    const nonce = nanoid();
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
      parentPort?.postMessage({ type: "INTERVAL-UPDATE", count });
      lastUpdate = Date.now();
    }

    count++;
  }
}

if (!isMainThread) {
  worker(workerData);
} else {
  const argv = yargs(hideBin(process.argv))
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
      }
    })
    .usage("Usage: $0 [options]")
    .example("$0 -p 'Alice' -d 20 -t 4", "Start mining with 4 threads and a difficulty of 20")
    .help()
    .parseSync();

  const THREAD_COUNT = Math.max(1, argv.threads);
  const UPDATE_INTERVAL = argv['update-interval'] * 1000;
  const FILE_NAME = `miner-${argv.pseudonym}-${Date.now()}.log`;

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

  // Push the initial value to the file name
  update_log(argv.pseudonym)

  console.log(`Starting miner with ${THREAD_COUNT} threads and a difficulty of ${startingDifficulty}.\n`);

  for (let i = 0; i < THREAD_COUNT; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        previous: argv.hash,
        difficulty: (startingDifficulty),
        pseudonym: argv.pseudonym,
        updateInterval: UPDATE_INTERVAL,
      } as WorkerData,
    });

    worker.on("message", async (data: { type: string, block: Block, count: number}) => {
      if (data?.type === "INTERVAL-UPDATE") {
        hashCount += data.count;
      } else if (data?.type === "UPDATE") {
        const block = data.block;        
        if (block.difficulty > lastBlock.difficulty) {
          console.log(`New best hash found! Difficulty: ${block.difficulty} | Nonce: ${block.nonce}`);
          await submitHash(block);
          blockCount++;
          if (block.difficulty >= (argv['max-difficulty'])) {
            console.log(`Required difficulty obtained! Total of ${blockCount} blocks to the chain. Runtime: ${formatDistanceToNowStrict(start)}`);
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

  async function submitHash(block: Block) {
    const formData = new FormData();
    formData.append("inputPreviousHash", block.previous.trim());
    formData.append("inputMiner", block.pseudonym.trim());
    formData.append("inputNonce", block.nonce.trim());
    formData.append("submit-block", "Submit New Block");

    try {
      const response = await fetch("https://www.cs.kent.ac.uk/people/staff/sb2213/toychain_comp6575_2425_a1/toy-chain.php", {
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