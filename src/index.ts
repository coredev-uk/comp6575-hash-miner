import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import winston from 'winston';

const pseudonym = 'lunar';

type HashPointer = {
    nonce: bigint,
    hash: string,
    difficulty: number
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

/**
 * Helper function to create a sha256 hash
 */
function createSha(previousHash: string, nonce: bigint = 0n): string {
    return createHash('sha256').update(`${previousHash}${pseudonym}${nonce}`).digest('hex');
}

/**
 * Get the difficulty of a nonce
 * @param nonce The nonce to check
 * @param pointer The pointer to check against
 * @returns The difficulty of the nonce
 */
function getNonceDifficulty(nonce: bigint, prevPointer: HashPointer): HashPointer {
    const hex = createSha(prevPointer.hash, nonce);

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

const workerProgress: { [id: number]: { done: number; start: number; end: number; } } = {};

function printProgress(workerId: number, data: {completed: number; start: number; end: number}) {
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
    process.stdout.write(`------------- WORKER PROGRESS -------------\nGlobal Progress: ${(completed / total).toFixed(2)}% \n\n${log.join('\n')}`);
}

/**
 * Asynchronously find a hash with a certain difficulty level
 * Once a hash is found, the promise should resolve with the hash pointer
 * @param prev The previous hash pointer
 * @param d The difficulty level
 */
async function findHashInRange(prev: HashPointer, d: number, start: bigint, end: bigint, workerId: number, chunkSize: bigint): Promise<HashPointer[]> {
    const callList: Promise<HashPointer>[] = [];
    let current: HashPointer = {
        nonce: 0n,
        hash: '',
        difficulty: 0
    };
    let done = 0n;

    const mineChunk = async (chunkStart: bigint, chunkEnd: bigint) => {
        for (let i = chunkStart; i < chunkEnd; i++) {
            const hash = getNonceDifficulty(i, prev)
            if (hash.difficulty > current.difficulty) {
                current = hash;
            }

            if (current.difficulty >= d) {
                parentPort?.postMessage({
                    type: 'event',
                    event: 'FOUND',
                    text: `Worker ${workerId} found a hash with difficulty ${d}`
                });
                break;
            }

            done++;
            if (done % 100000n === 0n) { // Reduce frequency of progress updates
                parentPort?.postMessage({
                    type: 'progress',
                    workerId,
                    data: {
                        completed: Number(done),
                        start: Number(start),
                        end: Number(end)
                    }
                });
            }
        }


        return current;
    }

    // chunk for every chunkSize upto maxSize
    for (let i = start; i < end; i += chunkSize) {
        callList.push(mineChunk(i, i + chunkSize))
    }

    return Promise.all(callList);
}

/**
 * Find a hash with a certain difficulty level
 */
async function main() {
    const prev: HashPointer = {
        nonce: 26975069n,
        hash: '00000057d4ea853d9331fea2e182e7a48b118ef70ef9203a6df250d6756a3acd',
        difficulty: 25
    }

    const d = 45;

    const workerSummaries: { [id: number]: { nonce: number; hash: number; difficulty: number; } } = {};

    if (isMainThread) {
        logger.info('Main thread running');

        const numWorkers = os.cpus().length; // Use the number of CPU cores
        const workers: Worker[] = [];
        const chunkSize = 100000n;
        const maxSize = 10000000000n;
        const chunksPerWorker = maxSize / BigInt(numWorkers);

        for (let i = 0; i < numWorkers; i++) {
            const start = BigInt(i) * chunksPerWorker;
            const end = start + chunksPerWorker;

            const worker = new Worker(new URL(import.meta.url), {
                workerData: { prev, d, start, end, chunkSize, workerId: i }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    printProgress(msg.workerId, msg.data);
                } else if (msg.type === 'event') {
                    switch (msg.event) {

                        case 'STARTED':
                            logger.info(msg.text);
                            break;

                        case 'FINISHED':
                            workerSummaries[i] = {
                                nonce: Number(msg.data.nonce),
                                hash: msg.data.hash,
                                difficulty: msg.data.difficulty
                            }
                            worker.terminate();
                            break;

                        case 'FOUND':
                            logger.info(msg.text);
                            logger.info(JSON.stringify(workerSummaries, null, 2));
                            workers.forEach((worker) => worker.terminate());
                            break;
                    }
                }
            });

            worker.on('error', (err) => {
                logger.error('Worker error:', err);
            });

            workers.push(worker);
        }

        const time = performance.now();

        await Promise.all(workers.map(worker => new Promise((resolve) => worker.on('exit', resolve))));

        logger.info('All workers finished');
        logger.info('Worker summaries:');
        logger.info(JSON.stringify(workerSummaries, null, 2));
        logger.info(`Time taken: ${performance.now() - time}ms`);
    } else {
        const { prev, d, start, end, workerId, chunkSize } = workerData;

        parentPort?.postMessage({
            type: 'event',
            event: 'STARTED',
            text: `Worker ${workerId} started with range ${start} to ${end}`,
        });

        const pointers = await findHashInRange(prev, d, start, end, workerId, chunkSize);

        const hash = pointers.reduce((prev, current) => {
            return current.difficulty > prev.difficulty ? current : prev;
        });

        parentPort?.postMessage({
            type: 'event',
            event: 'FINISHED',
            text: `Worker ${workerId} finished`,
            data: hash
        });
    }

}

await main()