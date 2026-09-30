import { BINARY_VERSION } from './binary.js';

// The binary's one entry point. A checkout runs the entry-*.js files directly instead.
const USAGE = `usage: promptd [command]

  (none)         run the hub and a node on this machine
  hub            run the hub: the web page and the jobs' storage
  node           run a node: fetches its jobs from the hub and runs them
  set-password   set the admin password (--print-hash, --clear)
  version        print the build this binary is`;

const [command, ...args] = process.argv.slice(2);
// Each entry reads its own flags from argv, as it does when run from a checkout.
process.argv = [process.argv[0]!, process.argv[1]!, ...args];

switch (command) {
  case undefined:
    await import('./entry-local.js');
    break;
  case 'hub':
    await import('./entry-hub.js');
    break;
  case 'node':
    await import('./entry-node.js');
    break;
  case 'set-password':
    await import('./entry-set-password.js');
    break;
  case 'version':
    console.log(BINARY_VERSION ?? 'development');
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE);
    break;
  default:
    console.error(`promptd: unknown command ${command}\n\n${USAGE}`);
    process.exitCode = 2;
}
