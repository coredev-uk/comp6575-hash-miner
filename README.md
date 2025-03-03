# COMP6575 Hash Miner

A simple hash miner that uses the SHA-256 algorithm to mine a hash with a given prefix.

## Overview

This project is hash mining script that operates across multiple 'Worker' processes. This script has been configured to use all available threads unless specified and will attempt to find a hash with a better difficulty than the previous. The script will use a `miner-PSEUDONYM-submission.log` file if available, this file is structured is the following format:
```plaintext
PSEUDONYM
PREVIOUSHASH PSEUDONYM NONCE
... (more hashes)
```
The script will read this file and use the last entry as the hash to start with. If the file is not available (or is yet to be), the script will require an input hash to start with.

Once a valid hash has been found, the script will attempt to make a POST request to the [Toychain](https://www.cs.kent.ac.uk/people/staff/sb2213/toychain_comp6575_2425_a1/toy-chain.php). If the request is successful, the script will write the hash to the `miner-PSEUDONYM-submission.log` file and continue to mine using the new hash as the previous.

## Packages

- `bun` - This is my chosen replacement for the Node.js runtime since it has a proven edge in speed and efficiency. All code used in the program can easily be moved to stock Node.js.
- `date-fns` - Just a simple date formatting library to make the logs look a bit nicer, not necessary.
- `nanoid` - A library to generate a unique nonce when the program is configured to generate random. This is a lot more effective than standard random libraries as shown on their [site](https://zelark.github.io/nano-id-cc/).
- `yargs` - A command line argument parser that is used to configure the program. This makes the script quite nice to work with when compiled.

## Usage

To run the script, you will need to have the `bun` runtime installed. This can be installed using the instructions on the [bun website](https://bun.sh/). Once installed, you can run the script using the following command:
```bash
bun install
bun run index.ts --pseudonym PSEUDONYM --threads THREADS
```

For a complete list of options, you can run the following command:
```bash
bun run index.ts --help
```

## Final Note

A executable file is bundled with the program that has pre-compiled for ease of use. This can be found in the `bin` directory. This file can be run using the following command:
```bash
./bin/miner --pseudonym PSEUDONYM --threads THREADS
```