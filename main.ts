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

// ----------------- CONFIGURATION -----------------
const PSEUDONYM = "lunar";
const THREAD_COUNT = Math.max(1, cpus().length - 1); // Use one less than available cores for efficiency
const MAX_NONCE = 100000000n;
const REQUIRED_DIFFICULTY = 45;
const PREVIOUS_HASH =
  "00000057d4ea853d9331fea2e182e7a48b118ef70ef9203a6df250d6756a3acd";

// ----------------- OPTIMIZED WORKER CODE -----------------
if (!isMainThread) {
  const { previousHash, difficulty, chunkStart, chunkEnd, pseudonym } =
    workerData;
  let nonce = chunkStart;

  while (nonce < chunkEnd) {
    const hash = createHash("sha256").update(
      previousHash + pseudonym + nonce.toString(),
    ).digest("hex");
    const binaryHash = BigInt("0x" + hash).toString(2).padStart(256, "0"); // Ensure full 256-bit binary representation
    const leadingZeros = binaryHash.indexOf("1"); // First occurrence of '1' gives leading zeros count

    if (leadingZeros >= difficulty) {
      parentPort?.postMessage({ nonce, hash, difficulty: leadingZeros });
      process.exit(0); // Early exit on success
    }

    nonce++;
  }
  parentPort?.postMessage("done");
} else {
  const start = performance.now();
  const chunkSize = MAX_NONCE / BigInt(THREAD_COUNT);
  let completed = 0;
  let found = false;

  for (let i = 0; i < THREAD_COUNT; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        previousHash: PREVIOUS_HASH,
        difficulty: REQUIRED_DIFFICULTY,
        chunkStart: BigInt(i) * chunkSize,
        chunkEnd: BigInt(i + 1) * chunkSize,
        pseudonym: PSEUDONYM,
      },
    });

    worker.on("message", (result) => {
      if (result === "done") {
        completed++;
      }

      if (result && result.nonce !== undefined && !found) {
        found = true;
        const time = ((performance.now() - start) / 1000)
        console.log(
          `\nFound valid hash: ${result.hash} at nonce ${result.nonce} with difficulty ${result.difficulty} in ${time.toFixed(2)} seconds.`,
        );
        writeFileSync(
          "result.json",
          JSON.stringify(
            {
              hash: result.hash,
              nonce: Number(result.nonce),
              difficulty: result.difficulty,
              duration: time,
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
