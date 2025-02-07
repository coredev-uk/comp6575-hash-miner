import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import winston from 'winston';

// ----------------- CONFIGURATION -----------------
const PSEUDONYM = 'lunar';
const THREAD_COUNT = -1; // Set to undefined to use all available cores
const MAX_NONCE = 10000000000n;
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

type WorkerData = {
	id: number;
	previousHash: Hash;
	difficulty: number;
	chunkStart: bigint;
	chunkEnd: bigint;
}

interface WorkerMessage {
	type: string;
	workerId: number;
	event: string;
	text: string;
	data?: object;
}

interface ProgressEvent extends WorkerMessage {
	type: 'progress';
	data: {
		completed: number;
		start: number;
		end: number;
	};
}

interface Event extends WorkerMessage {
	type: 'event';
	event: 'STARTED' | 'FINISHED' | 'FOUND';
	data: Hash;
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

const workerProgress: { [id: number]: { done: number; start: number; end: number; } } = {};
const workerSummaries: { [id: number]: { nonce: number; hash: string; difficulty: number; } } = {};
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
function getNonceDifficulty(nonce: bigint, prevPointer: Hash, buffer: { binary: Uint8Array }): Hash {
    const hex = createSha(prevPointer.hash, nonce);
    const binary = buffer.binary;

    for (let i = 0; i < hex.length; i++) {
        const bin = parseInt(hex[i], 16).toString(2).padStart(4, '0');
        for (let j = 0; j < 4; j++) {
            binary[i * 4 + j] = bin[j] === '0' ? 0 : 1;
        }
    }

    const leadingZeros = binary.findIndex(bit => bit !== 0);

    return {
        nonce,
        hash: hex,
        difficulty: leadingZeros === -1 ? binary.length : leadingZeros
    };
}


function printProgress(workerId: number, data: { completed: number; start: number; end: number }) {
    workerProgress[workerId] = {
        done: data.completed,
        start: data.start,
        end: data.end,
    };

    const log = Object.keys(workerProgress).map((id) => {
        const entry = workerProgress[Number(id)];
        const percent = (entry.done / (entry.end - entry.start)) * 100;
        return `Worker ${id}: ${percent.toFixed(2)}% (${entry.start + entry.done} / ${entry.end})`;
    })

    const total = Math.max(...Object.values(workerProgress).map((entry) => entry.end));
    const completed = Object.values(workerProgress).reduce((prev, entry) => prev + entry.done, 0);

    // Clear the console
    process.stdout.write('\x1Bc');
    process.stdout.write(`------------- WORKER PROGRESS -------------\nGlobal Progress: ${((completed / total) * 100).toFixed(2)}% \n\n${log.join('\n')}\n\n`);
}

/**
 * Asynchronously find a hash with a certain difficulty level
 * Once a hash is found, the promise should resolve with the hash pointer
 * @param worker The worker data
 * @param buffer The buffer to store the binary data
 */
async function findHashInRange(worker: WorkerData, chunkSubSize: bigint, buffer: { binary: Uint8Array }): Promise<Hash[]> {
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

                const hash = getNonceDifficulty(i, worker.previousHash, buffer);
                if (hash.difficulty > current.difficulty) {
                    current.nonce = hash.nonce;
                    current.hash = hash.hash;
                    current.difficulty = hash.difficulty;
                }

                if (current.difficulty >= worker.difficulty) {
                    parentPort?.postMessage({
                        type: 'event',
                        event: 'FOUND',
                        text: `Worker ${worker.id} found a hash with difficulty ${worker.difficulty}`,
                        data: current
                    });
                    found = true;
                    break;
                }

                done++;
                // Update progress every 10% of the range
                if (done % progressUpdateInterval === 0n) {
                    parentPort?.postMessage({
                        type: 'progress',
                        workerId: worker.id,
                        data: {
                            completed: Number(done),
                            start: Number(worker.chunkStart),
                            end: Number(worker.chunkEnd)
                        }
                    });
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
 * Create a worker with the given parameters
 * @param params The worker data
 */
function createWorker(params: WorkerData): Worker {
    const worker = new Worker(new URL(import.meta.url), {
        workerData: params
    });

    worker.on('message', (msg: ProgressEvent | Event) => {
        if (msg.type === 'progress') {
            printProgress(msg.workerId, (msg as ProgressEvent).data);
        }

        if (msg.type !== 'event') return;

        switch (msg.event) {
            case 'STARTED':
                logger.info(msg.text!);
                break;

            case 'FINISHED':
                workerSummaries[params.id] = {
                    nonce: Number(msg.data!.nonce),
                    hash: msg.data!.hash!,
                    difficulty: msg.data!.difficulty!
                };
                worker.terminate();
                break;

            case 'FOUND':
                logger.info(msg.text!);
                logger.info(JSON.stringify({
                    nonce: Number(msg.data!.nonce),
                    hash: msg.data!.hash!,
                    difficulty: msg.data!.difficulty!
                }));
                workerList.forEach(worker => worker.terminate());
                break;
        }
    });

    worker.on('error', (err) => {
        logger.error(`Worker ${params.id} error:`, err);
    });

    return worker;
}


async function main() {
    if (isMainThread) {
        logger.info('Main thread running');

        const numWorkers = THREAD_COUNT > 0 ? THREAD_COUNT : os.cpus().length - THREAD_COUNT;
        const baseChunkSize = MAX_NONCE / BigInt(numWorkers);
        const minChunkSize = 1000n;
        const maxChunkSize = baseChunkSize < MAX_NONCE ? baseChunkSize : MAX_NONCE;
        const chunkSize = baseChunkSize < minChunkSize ? minChunkSize : (baseChunkSize > maxChunkSize ? maxChunkSize : baseChunkSize);
        const remainder = MAX_NONCE % BigInt(numWorkers);

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

        const time = performance.now();

        await Promise.all(workerList.map(worker => new Promise((resolve) => worker.on('exit', resolve))));

        logger.info('All workers finished');
        logger.info('Worker summaries:');
        logger.info(JSON.stringify(workerSummaries, null, 2));
        logger.info(`Time taken: ${((performance.now() - time) / 1000 / 60).toFixed(2)}m`);
    } else {
        // Worker thread
        const worker = workerData as WorkerData;
		const chunkSubSize = (worker.chunkEnd - worker.chunkStart) / 10000n;

        logger.info(`Worker ${worker.id} started with range ${worker.chunkStart} to ${worker.chunkEnd}`);

        const pointers = await findHashInRange(worker, chunkSubSize, { binary: new Uint8Array() });

        const hash = pointers.reduce((prev, current) => {
            return current.difficulty > prev.difficulty ? current : prev;
        });

        parentPort?.postMessage({
            type: 'event',
            event: 'FINISHED',
            text: `Worker ${worker.id} finished`,
            data: hash
        });
    }
}

main().catch(err => logger.error(err));
