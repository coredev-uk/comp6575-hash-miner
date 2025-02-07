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
        new winston.transports.File({ filename: 'hash-miner.log' })
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

function printProgress(current: number, total: number) {
    process.stdout.clearLine(1);
    process.stdout.cursorTo(0);
    process.stdout.write(`Progress: ${current}/${total} (${(current / total * 100).toFixed(2)}%)`);
}

/**
 * Asynchronously find a hash with a certain difficulty level
 * Once a hash is found, the promise should resolve with the hash pointer
 * @param prev The previous hash pointer
 * @param d The difficulty level
 */
async function findHash(prev: HashPointer, d: number) {
    const chunkSize = 100000n;
    const maxSize = 100000000n;
    const callList: any[] = [];
    let found = false;
    let current: HashPointer = prev;
    let done = 0n;

    const mineChunk = async (start: bigint, end: bigint) => {
        for (let i = start; i < end; i++) {
            if (found) return;
            const curr = getNonceDifficulty(i, prev)
            if (curr.difficulty > current.difficulty) {
                current = curr;
            }

            if (current.difficulty >= d) {
                found = true;
                return;
            }
            done++;
            if (done % 100000n === 0n) { // Reduce frequency of progress updates
                parentPort?.postMessage({
                    type: 'progress',
                    current: Number(done),
                    total: Number(maxSize)
                });
            }
        }
    }

    // chunk for every chunkSize upto maxSize
    for (let i = 0n; i < maxSize; i += chunkSize) {
        callList.push(mineChunk(i, i + chunkSize))
    }

    parentPort?.postMessage({
        type: 'event',
        event: 'STARTED',
        data: {
            'Requested Difficulty': d,
            'Call Count': callList.length,
            'Chunk Size': chunkSize,
            'Max Size': maxSize
        }
    });

    await Promise.all(callList);
    return current;
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

    if (isMainThread) {
        logger.info('Main thread running');

        const numWorkers = os.cpus().length; // Use the number of CPU cores
        const workers: Worker[] = [];

        for (let i = 0; i < numWorkers; i++) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: { prev, d }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    printProgress(msg.current, msg.total);
                } else if (msg.type === 'event') {
                    logger.info(`------ ${msg.event} ------`);
                    if (msg.text) logger.info(msg.text);
                    if (msg.data) logger.info(JSON.stringify(msg.data, null, 2));
                }
            });

            worker.on('error', (err) => {
                logger.error('Worker error:', err);
            });

            workers.push(worker);
        }

        await Promise.all(workers.map(worker => new Promise((resolve) => worker.on('exit', resolve))));

    } else {
        const { prev, d } = workerData;
        const hash = await findHash(prev, d);

        parentPort?.postMessage({
            type: 'event',
            event: 'FINISHED',
            text: 'Best hash found:',
            result: hash
        });
    }

}

await main()