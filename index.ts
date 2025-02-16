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

const argv = yargs(process.argv)
  .option("pseudonym", {
    alias: "p",
    type: "string",
    description: "Pseudonym to use in the hash",
  })
  // .demandOption("pseudonym")
  .option("threads", {
    alias: "t",
    type: "number",
    description: "Number of threads to use",
  })
  .option("difficulty", {
    alias: "d",
    type: "number",
    description: "Difficulty level to reach",
  })
  .option("previous", {
    alias: "prev",
    type: "string",
    description: "Previous hash value",
  })
  // .demandOption(["pseudonym", "previous"])
  .usage("Usage: $0 -p [pseudonym] --previous [previous hash]")
  .help()
  .alias("help", "h")
  .parseSync();

// ----------------- CONFIGURATION -----------------
const PSEUDONYM = argv.pseudonym
const THREAD_COUNT = Math.max(1, argv.threads || (cpus().length - 1));
const REQUIRED_DIFFICULTY = argv.difficulty || 20;
const PREVIOUS_HASH = argv.previous
const BLOCK_SIZE = Infinity; // Number of nonces to check per thread
// ----------------- OPTIMIZED WORKER CODE -----------------
if (!isMainThread) {
  const { previousHash, difficulty, size, pseudonym } = workerData;
  let bestDifficulty = 25;
  let count = 0;
  let lastUpdate = Date.now();

  for (let i = 0; i < size; i++) {
    const nonce = nanoid();

    const hash = new Bun.CryptoHasher("sha256")
      .update(`${previousHash}${pseudonym}${nonce}`)
      .digest("hex");
    const binaryHash = BigInt("0x" + hash).toString(2).padStart(256, "0"); // Ensure full 256-bit binary representation
    const leadingZeros = binaryHash.indexOf("1"); // First occurrence of '1' gives leading zeros count

    if (leadingZeros >= difficulty) {
      parentPort?.postMessage({ type: "RESULT", nonce, difficulty: leadingZeros });
      process.exit(0); // Early exit on success
    }

    if (leadingZeros > bestDifficulty) {
      parentPort?.postMessage({ type: "UPDATE", nonce, difficulty: leadingZeros });
      bestDifficulty = leadingZeros;
    }

    // Every hour send an update with the best difficulty so far and the count
    if (Date.now() - lastUpdate > 60 * 60 * 1000) {
      parentPort?.postMessage({ type: "UPDATE", nonce, difficulty: bestDifficulty, count });
      lastUpdate = Date.now();
    }

    count++;
  }

  parentPort?.postMessage("done");
} else {
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
  log(`Starting hash mining with: \n${THREAD_COUNT} threads, \nDifficulty: ${REQUIRED_DIFFICULTY}, \nPrevious hash: ${PREVIOUS_HASH}, \nPseudonym: ${PSEUDONYM}`);
  let completed = 0;
  let found = false;
  let currentBest = {
    difficulty: 0,
    nonce: 0,
  }
  let count = 0;

  for (let i = 0; i < THREAD_COUNT; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        previousHash: PREVIOUS_HASH,
        difficulty: REQUIRED_DIFFICULTY,
        size: BLOCK_SIZE,
        pseudonym: PSEUDONYM,
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
          if (result.count) {
            count += result.count;
            log(`Total nonces checked so far: ${count}`);
          }
        }
      } else if (result?.type === "RESULT" && !found) {
        found = true;
        log(
          `Found valid hash: ${result.hash} at nonce ${result.nonce} with difficulty ${result.difficulty} in ${formatDistanceToNowStrict(start)}`,
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
