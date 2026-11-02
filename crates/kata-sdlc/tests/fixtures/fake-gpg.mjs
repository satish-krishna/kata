// A stand-in for gpg, as git's `gpg.program` protocol sees it: git writes the commit to stdin and calls
// `--status-fd=2 -bsau <key>`; the program answers a signature on stdout and `[GNUPG:] SIG_CREATED` on stderr.
// The signature is a fixed text, so a test can tell a signed commit from an unsigned one.
import { readFileSync, writeSync } from 'node:fs';

readFileSync(0);
writeSync(2, '[GNUPG:] SIG_CREATED D 1 8 00 1 FAKEFINGERPRINT\n');
writeSync(1, '-----BEGIN PGP SIGNATURE-----\n\nFAKE-SIGNATURE\n-----END PGP SIGNATURE-----\n');
