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

if (!isMainThread) {
  const { previousHash, difficulty, size, pseudonym, updateInterval } = workerData;
  let bestDifficulty = 25;
  let count = 0;
  
  setInterval(() => {
    parentPort?.postMessage({ type: "INTERVAL-UPDATE", count });
  }, updateInterval);

  for (let i = 0; i < size; i++) {
    const nonce = nanoid();

    const hash = new Bun.CryptoHasher("sha256")
      .update(`${previousHash ?? ''}${pseudonym}${nonce}`)
      .digest("hex");
    const binaryHash = BigInt("0x" + hash).toString(2).padStart(256, "0"); // Ensure full 256-bit binary representation
    const leadingZeros = binaryHash.indexOf("1"); // First occurrence of '1' gives leading zeros count

    if (leadingZeros >= difficulty) {
      parentPort?.postMessage({ type: "RESULT", nonce, difficulty: leadingZeros, hash: hash });
      process.exit(0); // Early exit on success
    }

    if (leadingZeros > bestDifficulty) {
      parentPort?.postMessage({ type: "UPDATE", nonce, difficulty: leadingZeros, count });
      bestDifficulty = leadingZeros;
    }

    count++;
  }

  parentPort?.postMessage("done");
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
      default: cpus().length - 1,
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
      description: "Interval in minutes to log the best nonce",
      default: 60 * 60 * 1000,
    },

  })
  .usage("Usage: $0 -p [pseudonym] -h [hash] -t [threads] -d [difficulty] -c [capacity]")
  .help()
  .parseSync();

  const PSEUDONYM = argv.pseudonym || 'default';
  const THREAD_COUNT = Math.max(1, argv.threads);
  const REQUIRED_DIFFICULTY = argv.difficulty || 20;
  const PREVIOUS_HASH = argv.hash || null
  const BLOCK_SIZE = argv.capacity || Infinity;
  const UPDATE_INTERVAL = argv['update-interval'] * 1000;

  writeFileSync("hasher.log", ""); // Clear log file

  const log = (message: string) => {
    console.log(`[${format(new Date(Date.now()), 'dd/MM/yy kk:mm')}] ${message}\n`);
    writeFileSync(
      "hasher.log",
      `${new Date(Date.now()).toISOString()} - ${message}\n`,
      { flag: "a" },
    );
  }

  const start = Date.now();
  log(`Starting hash mining with ${THREAD_COUNT} workers.`);
  console.table({
    threads: THREAD_COUNT,
    difficulty: REQUIRED_DIFFICULTY,
    previousHash: PREVIOUS_HASH,
    pseudonym: PSEUDONYM,
  })
  console.log();
  let completed = 0;
  let found = false;
  let currentBest = {
    difficulty: 0,
    nonce: 0,
  }
  let count = 0;

  setInterval(() => {
    log(`Total nonces checked: ${count.toLocaleString()}`);
  }, UPDATE_INTERVAL);


  for (let i = 0; i < THREAD_COUNT; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        previousHash: PREVIOUS_HASH,
        difficulty: REQUIRED_DIFFICULTY,
        size: BLOCK_SIZE,
        pseudonym: PSEUDONYM,
        updateInterval: UPDATE_INTERVAL,
      },
    });

    worker.on("message", (result) => {
      if (result === "done") {
        completed++;
      }

      if (result?.type === "UPDATE") {
        if (result.difficulty > currentBest.difficulty) {
          currentBest = {
            difficulty: result.difficulty,
            nonce: result.nonce,
          }
          log(`Best nonce so far: ${result.nonce} with difficulty ${result.difficulty}`);
          count += result.count;
        }
      } else if (result?.type === "INTERVAL-UPDATE") {
        count += result.count;
      } else if (result?.type === "RESULT" && !found) {
        found = true;
        log(
          `Found valid hash: \n${result.hash}\nNonce: ${result.nonce} (d = ${result.difficulty})\nCompleted in ${formatDistanceToNowStrict(start)}`,
        );
        writeFileSync(
          "result.json",
          JSON.stringify(
            {
              hash: result.hash,
              nonce: Number(result.nonce),
              difficulty: result.difficulty,
              duration: formatDistanceToNowStrict(start),
            },
            null,
            2,
          ),
        );
        process.exit(0); // Stop all processes early
      }

      if (completed === THREAD_COUNT && !found) {
        log(
          "No valid hash found. Increase difficulty range or adjust nonce limits.",
        );
      }
    });

    worker.on("error", (error) => {
      console.error(error);
    });
  }
}
