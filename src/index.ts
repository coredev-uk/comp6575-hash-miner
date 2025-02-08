import { createHash } from 'node:crypto';
import { createInterface, moveCursor } from 'node:readline';
import os from 'os';
import winston from 'winston';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

// ----------------- CONFIGURATION -----------------
const PSEUDONYM = 'lunar';
const THREAD_COUNT = -1; // Set to negative to take away from the number of cores available or positive to add or 0 to use all cores
const MAX_NONCE = 100000000000n;
const REQUIRED_DIFFICULTY = 45;
const PREVIOUS_HASH: Hash = {
    nonce: 26975069n,
    hash: '00000057d4ea853d9331fea2e182e7a48b118ef70ef9203a6df250d6756a3acd',
    difficulty: 25
};
// -------------------------------------------------

type Hash = {
    nonce: bigint,
    hash: string,
    difficulty: number
}

type Progress = {
    completed: number;
    start: number;
    end: number;
}

type WorkerData = {
    id: number;
    previousHash: Hash;
    difficulty: number;
    chunkStart: bigint;
    chunkEnd: bigint;
}

interface WorkerMessage {
    workerId: number;
    event: 'PROGRESS' | 'STARTED' | 'FINISHED' | 'FOUND';
    text: string;
    data?: Hash | Progress;
}

// Configure winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'hash-miner.log', options: { flags: 'w' } })
    ]
});

const workerProgress: { [id: number]: Progress } = {};
const workerSummaries: { [id: number]: Hash } = {};
const workerList: Worker[] = [];


/**
 * Helper function to create a sha256 hash
 */
function createSha(previousHash: string, nonce: bigint = 0n): string {
    return createHash('sha256').update(`${previousHash}${PSEUDONYM}${nonce}`).digest('hex');
}

/**
 * Get the difficulty of a nonce
 * @param nonce The nonce to check
 * @param pointer The pointer to check against
 * @returns The difficulty of the nonce
 */
function createSHA256(nonce: bigint, hash: string): Hash {
    const hex = createSha(hash, nonce);

    // Convert the hex to binary with leading zeros
    const binary = hex.split('').map((char) => {
        return parseInt(char, 16).toString(2).padStart(4, '0');
    }).join('');

    // Count the number of leading zeros
    const leadingZeros = binary.match(/^0*/)?.[0].length;

    return {
        nonce,
        hash: hex,
        difficulty: leadingZeros || 0
    }
}

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
});

function printProgress(workerId: number, data: Progress) {
    workerProgress[workerId] = {
        completed: data?.completed || 0,
        start: data?.start || 0,
        end: data?.end || 0,
    };

    const total = Math.max(...Object.values(workerProgress).map((entry) => entry.end));
    const completed = Object.values(workerProgress).reduce((prev, entry) => prev + entry.completed, 0);
    const progress = (completed / total) * 100;

    moveCursor(process.stdout, -50, 0); // Move cursor left by 50 characters to overwrite the progress
    process.stdout.write(`Progress: ${progress.toFixed(2)}%`);

}

/**
 * Asynchronously find a hash with a certain difficulty level
 * Once a hash is found, the promise should resolve with the hash pointer
 * @param worker The worker data
 * @param buffer The buffer to store the binary data
 */
async function findHashInRange(worker: WorkerData, chunkSubSize: bigint): Promise<Hash[]> {
    const callList: Promise<Hash>[] = [];
    const dataSize = worker.chunkEnd - worker.chunkStart;
    const progressUpdateInterval = dataSize / 10n;
    let current: Hash = {
        nonce: 0n,
        hash: '',
        difficulty: 0
    };
    let done = 0n;
    let found = false;

    const mineChunk = async (chunkStart: bigint, chunkEnd: bigint) => {
        try {
            for (let i = chunkStart; i < chunkEnd; i++) {
                if (found) return current;

                const hash = createSHA256(i, worker.previousHash.hash);
                if (hash.difficulty > current.difficulty) {
                    current.nonce = hash.nonce;
                    current.hash = hash.hash;
                    current.difficulty = hash.difficulty;
                }

                if (current.difficulty >= worker.difficulty) {
                    parentPort?.postMessage({
                        event: 'FOUND',
                        workerId: worker.id,
                        text: `Worker ${worker.id} found a hash with difficulty ${worker.difficulty}`,
                        data: current
                    } as WorkerMessage);
                    found = true;
                    break;
                }

                done++;
                // Update progress every 10% of the range
                if (done % progressUpdateInterval === 0n) {
                    parentPort?.postMessage({
                        event: 'PROGRESS',
                        workerId: worker.id,
                        data: {
                            completed: Number(done),
                            start: Number(worker.chunkStart),
                            end: Number(worker.chunkEnd)
                        }
                    } as WorkerMessage);
                }
            }
        } catch (error) {
            logger.error(`Error in worker ${worker.id} during mining:`, error);
        }

        return current;
    }

    // chunk for every chunkSize upto maxSize
    for (let i = worker.chunkStart; i < worker.chunkEnd; i += chunkSubSize) {
        callList.push(mineChunk(i, i + chunkSubSize));
    }

    return Promise.all(callList);
}

/**
 * Estimate the time it will take to find a hash with the required difficulty 2^256 - difficulty
 * @param threads 
 * @param difficulty 
 */
function estimateTime(threads: number, difficulty: number): number {
    const requiredCalls = Math.pow(2, 256 - difficulty) / threads;

    // Run the hashing process for a fixed duration (e.g., 100ms) to measure the time per call
    const duration = 1000; // in milliseconds
    const start = performance.now();
    let iterations = 0;

    while (performance.now() - start < duration) {
        createSHA256(BigInt(iterations), PREVIOUS_HASH.hash);
        iterations++;
    }

    const end = performance.now();
    const timePerCall = (end - start) / iterations; // average time per call in milliseconds

    return requiredCalls * timePerCall / 1000; // convert to seconds
}

/**
 * Create a worker with the given parameters
 * @param params The worker data
 */
function createWorker(params: WorkerData): Worker {
    const worker = new Worker(new URL(import.meta.url), {
        workerData: params
    });

    worker.on('message', (msg: WorkerMessage) => {
        switch (msg.event) {
            case 'PROGRESS':
                return printProgress(msg.workerId, msg.data as Progress);

            case 'STARTED':
                return logger.info(msg.text);

            case 'FINISHED':
                workerSummaries[msg.workerId] = msg.data as Hash;
                return worker.terminate();

            case 'FOUND':
                logger.info(msg.text!);
                logger.info({
                    nonce: Number((msg.data as Hash).nonce),
                    hash: (msg.data as Hash).hash,
                    difficulty: (msg.data as Hash).difficulty
                });
                return workerList.forEach(worker => worker.terminate());

            default:
                throw new Error(`Unknown message event: ${msg.event}`);
        }
    });

    worker.on('error', (err) => {
        logger.error(`Worker ${params.id} error:`, err);
    });

    return worker;
}

function msToTime(duration: number) {
    const milliseconds = Math.floor((duration % 1000) / 100),
        seconds = Math.floor((duration / 1000) % 60),
        minutes = Math.floor((duration / (1000 * 60)) % 60),
        hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

    return `${hours}h ${minutes}m ${seconds}s ${milliseconds}ms`;
}


/**
 * Main thread entry point
 */
async function main() {
    const numWorkers = THREAD_COUNT > 0 ? THREAD_COUNT : os.cpus().length + THREAD_COUNT;
    const baseChunkSize = MAX_NONCE / BigInt(numWorkers);
    const minChunkSize = 1000n;
    const maxChunkSize = baseChunkSize < MAX_NONCE ? baseChunkSize : MAX_NONCE;
    const chunkSize = baseChunkSize < minChunkSize ? minChunkSize : (baseChunkSize > maxChunkSize ? maxChunkSize : baseChunkSize);
    const remainder = MAX_NONCE % BigInt(numWorkers);

    logger.info('Main thread running');
    logger.info(`Using ${numWorkers} workers with chunk size ${chunkSize} and remainder ${remainder}`);
    logger.info(`Estimated time to find a hash with difficulty ${REQUIRED_DIFFICULTY}: ${msToTime(estimateTime(numWorkers, REQUIRED_DIFFICULTY))}`);
    const time = performance.now();

    for (let i = 0; i < numWorkers; i++) {
        const start = BigInt(i) * chunkSize;
        const end = start + chunkSize + (i === numWorkers - 1 ? remainder : 0n);
        const worker = createWorker({
            previousHash: PREVIOUS_HASH,
            difficulty: REQUIRED_DIFFICULTY,
            chunkStart: start,
            chunkEnd: end,
            id: i
        });
        workerList.push(worker);
    }

    await Promise.all(workerList.map(worker => new Promise((resolve) => worker.on('exit', resolve))));
    rl.close();
    console.log('\n');
    logger.info(`Completed in ${((performance.now() - time) / 1000 / 60).toFixed(2)}m`);
    const bestHash = Object.values(workerSummaries).reduce((prev, current) => {
        return current.difficulty > prev.difficulty ? current : prev;
    });
    logger.info(`Best nonce: ${Number(bestHash.nonce)} with difficulty ${bestHash.difficulty}`);
}

/**
 * Worker thread entry point
 */
async function worker() {
    // Worker thread
    const worker = workerData as WorkerData;
    const chunkSubSize = (worker.chunkEnd - worker.chunkStart) / 10000n;

    parentPort?.postMessage({
        event: 'STARTED',
        workerId: worker.id,
        text: `Worker ${worker.id} started with range ${worker.chunkStart} to ${worker.chunkEnd}`
    } as WorkerMessage);

    const pointers = await findHashInRange(worker, chunkSubSize);

    const hash = pointers.reduce((prev, current) => {
        return current.difficulty > prev.difficulty ? current : prev;
    });

    parentPort?.postMessage({
        event: 'FINISHED',
        workerId: worker.id,
        text: `Worker ${worker.id} finished`,
        data: hash
    } as WorkerMessage);
}

if (isMainThread) {
    main().catch((err) => {
        logger.error('Main thread error:', err);
    });
} else {
    worker().catch((err) => {
        throw err;
    });
}
