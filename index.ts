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
import { formatDistanceToNowStrict, format } from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

function worker(data: { size: number; pseudonym: string; updateInterval: number; difficulty: number; previous: string }) {
  const { size, pseudonym, updateInterval } = data;
  let bestDifficulty = workerData.difficulty;
  let previousHash = workerData.previous
  let count = 0;
  let lastUpdate = Date.now();

  parentPort?.on("HASH-UPDATE", (data) => {
    previousHash = data.hash;
    bestDifficulty = data.difficulty;
  });

  for (let i = 0; i < size; i++) {
    const nonce = nanoid();
    const raw = `${previousHash ?? ''}${pseudonym}${nonce}`;
    const sha = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const bin = BigInt("0x" + sha).toString(2).padStart(256, "0");
    const difficulty = bin.indexOf("1")

    if (difficulty > bestDifficulty) {
      parentPort?.postMessage({
        type: "UPDATE",
        data: {
          nonce,
          hash: sha,
          raw,
          difficulty: difficulty,
          count
        }
      });
    }

    // Update every updateInterval milliseconds
    if (Date.now() - lastUpdate > (updateInterval * 0.95)) {
      parentPort?.postMessage({ type: "INTERVAL-UPDATE", count });
      lastUpdate = Date.now();
    }

    count++;
  }

  parentPort?.postMessage("done");
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
      },
      "threads": {
        alias: "t",
        type: "number",
        description: "Number of threads to use",
        default: cpus().length,
      },
      "difficulty": {
        alias: "d",
        type: "number",
        description: "The minimum difficulty level to reach",
        default: 20,
      },
      "capacity": {
        alias: "c",
        type: "number",
        description: "Number of nonces to check per thread",
        default: Infinity,
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
    .example("$0 -p 'Bob' -d 25 -t 8 -c 100000", "Start mining with 8 threads and a difficulty of 25, checking 100,000 nonces per thread")
    .help()
    .parseSync();

  const THREAD_COUNT = Math.max(1, argv.threads);
  const UPDATE_INTERVAL = argv['update-interval'] * 1000;
  const FILE_NAME = `miner-${argv.pseudonym}-${Date.now()}.log`;

  const update_log = (message: string) => {
    writeFileSync(FILE_NAME, message, { flag: 'a' })
  }

  const start = Date.now();
  console.log(`Starting hash mining with ${THREAD_COUNT} workers.`);
  let hashCount = 0;
  let blockCount = 0;
  let lastBlock = {
    difficulty: BigInt("0x" + argv.hash).toString(2).padStart(256, "0"),
    nonce: null as string | null,
    sha256: argv.hash
  }
  const workers: Worker[] = [];

  // Push the initial value to the file name
  update_log(argv.pseudonym)

  for (let i = 0; i < THREAD_COUNT; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        previousHash: argv.hash,
        difficulty: argv.difficulty,
        size: argv.capacity,
        pseudonym: argv.pseudonym,
        updateInterval: UPDATE_INTERVAL,
      },
    });

    worker.on("message", async (block) => {
      if (block?.type === "INTERVAL-UPDATE") {
        hashCount += block.count;
      } else {
        if (block.difficulty > lastBlock.difficulty) {
          lastBlock = {
            difficulty: block.difficulty,
            nonce: block.nonce,
            sha256: block.hash
          }
          console.log(`New best hash found! Difficulty: ${block.difficulty} | Nonce: ${block.nonce}`);
          await submitHash(lastBlock.sha256!, argv.pseudonym, block.nonce);
          updatePreviousHash(block.hash, block.difficulty);
          blockCount++;

          if (block.difficulty >= argv.difficulty) {
            console.log(`Required difficulty obtained! Added ${blockCount} blocks to the chain.`);
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
    console.log(`[INTERVAL-UPDATE] Total hashes computed: ${hashCount.toLocaleString()} | Elapsed runtime: ${formatDistanceToNowStrict(start)}`, true);
  }, UPDATE_INTERVAL);

  async function submitHash(previousHash: string, pseudonym: string, nonce: string) {
    const formData = new FormData();
    formData.append("inputPreviousHash", previousHash.trim());
    formData.append("inputMiner", pseudonym.trim());
    formData.append("inputNonce", nonce.trim());
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

      const message = data.match(/<h3>(.*?)<\/h3>/)?.[1]?.trim();

      if (message?.includes("Congratulations")) {

        // Update the hash
        lastBlock = {
          difficulty: BigInt("0x" + lastBlock.hash).toString(2).padStart(256, "0"),
          nonce,
          hash: lastBlock.hash
        }
        update_log(`${previousHash}${pseudonym}${nonce}\n`);
        workers.forEach((worker) => {
          worker.postMessage({ type: "BLOCK-UPDATE", block: lastBlock });
        });

        return message;
      } else {
        throw new Error(`Block submission failed. (${message?.replace('Sorry, your block was not added to the chain.', '')})`);
      }
    } catch (error) {
      console.error("Error submitting hash: ", error);
    }
  }

}