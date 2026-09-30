// Local type declarations for noise-handshake 4.x (plain JavaScript; the published
// @types/noise-handshake targets the 3.x API). Kept to the surface the tunnel uses.

declare module 'noise-handshake' {
    class NoiseState {
        constructor(
            pattern: NoiseState.Pattern,
            initiator: boolean,
            staticKeypair?: NoiseState.Keypair | null,
            opts?: NoiseState.Options,
        )

        readonly s: NoiseState.Keypair
        e: NoiseState.Keypair | null
        re: Buffer | null
        /** The remote static: pre-shared (initiator, IK) or learned from the `s` token. */
        rs: Buffer | null
        readonly pattern: NoiseState.Pattern
        readonly initiator: boolean
        readonly protocol: Buffer
        complete: boolean
        /** Transport key for messages this side sends (k1 for the initiator, k2 for the responder). */
        tx: Buffer | null
        /** Transport key for messages this side receives. */
        rx: Buffer | null
        /** Handshake hash, available once `complete`. */
        hash: Buffer | null

        initialise(prologue: Buffer, remoteStatic?: Buffer): void
        send(payload?: Buffer): Buffer
        recv(buf: Buffer): Buffer
        getHandshakeHash(out?: Buffer): Buffer
    }

    namespace NoiseState {
        type Pattern = 'NN' | 'NNpsk0' | 'XX' | 'XXpsk0' | 'IK' | 'XK'
        interface Keypair {
            publicKey: Buffer
            secretKey: Buffer
        }
        interface Options {
            curve?: unknown
            psk?: Buffer
        }
    }

    export = NoiseState
}

declare module 'noise-handshake/cipher' {
    class CipherState {
        constructor(key?: Buffer | null)
        key: Buffer | null
        nonce: number
        readonly hasKey: boolean
        readonly CIPHER_ALG: string
        initialiseKey(key: Buffer): void
        setNonce(nonce: number): void
        encrypt(plaintext: Buffer, ad?: Buffer): Buffer
        decrypt(ciphertext: Buffer, ad?: Buffer): Buffer
        static readonly MACBYTES: number
        static readonly NONCEBYTES: number
        static readonly KEYBYTES: number
    }

    export = CipherState
}

declare module 'noise-handshake/dh' {
    import type NoiseState from 'noise-handshake'

    export const DHLEN: number
    export const PKLEN: number
    export const SKLEN: number
    export const SEEDLEN: number
    export const ALG: string
    export function generateKeyPair(privKey?: Buffer): NoiseState.Keypair
    export function generateSeedKeyPair(seed: Buffer): NoiseState.Keypair
    export function dh(publicKey: Buffer, keypair: { secretKey: Buffer }): Buffer
}
