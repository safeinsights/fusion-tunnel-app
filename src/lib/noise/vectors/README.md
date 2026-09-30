# Noise test vectors

`ik-25519-chachapoly-blake2b.json` is the `Noise_IK_25519_ChaChaPoly_BLAKE2b` entry from the
cacophony vector set (`https://github.com/centromere/cacophony/blob/master/vectors/cacophony.txt`),
the vectors the Noise community cross-checks implementations against. `session.test.ts` drives
`noise-handshake` with the vector's static and ephemeral keys and checks every handshake and
transport message byte-for-byte, then checks the tunnel's own transport cipher against the
same transport messages.
