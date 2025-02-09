import { createHash } from "node:crypto";
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

// ----------------- CONFIGURATION -----------------
const PSEUDONYM = "lunar";
const THREAD_COUNT = Math.max(1, cpus().length - 1); // Use one less than available cores for efficiency
const REQUIRED_DIFFICULTY = 45;
const PREVIOUS_HASH = "00000001c3e6b414dd1745219ac497b02da76d16639e9ccabb06509751e5f6a7";
const BLOCK_SIZE = Infinity; // Number of nonces to check per thread
// ----------------- OPTIMIZED WORKER CODE -----------------
if (!isMainThread) {
  const { previousHash, difficulty, size, pseudonym } = workerData;
  let bestDifficulty = 25;

  for (let i = 0; i < size; i++) {
    const nonce = nanoid();

    const hash = createHash("sha256").update(
      previousHash + pseudonym + nonce.toString(),
    ).digest("hex");
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
  }

  parentPort?.postMessage("done");
} else {
  const start = Date.now();
  console.log(`Mining with ${THREAD_COUNT} threads...`);
  let completed = 0;
  let found = false;
  let currentBest = {
    difficulty: 0,
    nonce: 0,
  }

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
          console.log(`[${formatDistanceToNowStrict(start)}] Best nonce so far: ${result.nonce} with difficulty ${result.difficulty}`);
        }
      } else if (result?.type === "RESULT" && !found) {
        found = true;
        console.log(
          `\nFound valid hash: ${result.hash} at nonce ${result.nonce} with difficulty ${result.difficulty} in ${formatDistanceToNowStrict(start)}`,
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
        console.log(
          "\nNo valid hash found. Increase difficulty range or adjust nonce limits.",
        );
      }
    });

    worker.on("error", (error) => {
      console.error(error);
    });
  }
}
