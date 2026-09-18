import { PROLOGUE_DOMAIN, PrologueInputsSchema, type PrologueInputs } from '@/schemas/channel'
import type { ConfigurationBundle } from '@/schemas/provisioning'

const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.byteLength > 0xffff) throw new RangeError('prologue field exceeds 65535 bytes')
    const out = Buffer.alloc(2 + bytes.byteLength)
    out.writeUInt16BE(bytes.byteLength, 0)
    bytes.copy(out, 2)
    return out
}

const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4)
    out.writeUInt32BE(value, 0)
    return out
}

/** Canonical prologue bytes (schemas/channel.ts). Throws on invalid inputs. */
export const encodePrologue = (inputs: PrologueInputs): Buffer => {
    const p = PrologueInputsSchema.parse(inputs)
    return Buffer.concat([
        Buffer.from(PROLOGUE_DOMAIN, 'ascii'),
        lengthPrefixed(p.studyId),
        lengthPrefixed(p.relaySessionId),
        lengthPrefixed(p.sourceOrgSlug),
        lengthPrefixed(p.destinationOrgSlug),
        u32(p.sourceGeneration),
        u32(p.destinationGeneration),
        p.sessionNonce,
    ])
}

/** Map a configuration bundle plus the verified peer generation onto positional prologue inputs. */
export const prologueInputsFor = (bundle: ConfigurationBundle, peerGeneration: number): PrologueInputs => {
    const own = { slug: bundle.orgSlug, generation: bundle.keyGeneration }
    const peer = { slug: bundle.peerOrgSlug, generation: peerGeneration }
    const [source, destination] = bundle.role === 'source' ? [own, peer] : [peer, own]
    return {
        studyId: bundle.studyId,
        relaySessionId: bundle.relay.sessionId,
        sourceOrgSlug: source.slug,
        destinationOrgSlug: destination.slug,
        sourceGeneration: source.generation,
        destinationGeneration: destination.generation,
        sessionNonce: Buffer.from(bundle.sessionNonce, 'base64url'),
    }
}
