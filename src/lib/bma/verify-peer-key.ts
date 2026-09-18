import type { VerifiedPeer } from '@/lib/channel'
import { fingerprintOf } from '@/lib/identity'
import { verifyKeyBlobSignature, type PeerKeyResponse } from '@/schemas/bma'
import type { ConfigurationBundle } from '@/schemas/provisioning'

// The peer-key verification chain (v2 §5, invariant 8): the blob's org signature is checked
// against the PINNED peer-org key from the configuration bundle — never against anything in the
// directory response — and the generation must be at least as new as the last one seen
// (bootstrapped from the first fetch; strictly newer when a re-fetch follows PEER_REJOINED).

export type PeerKeyRejection =
    'wrong_study' | 'wrong_leg' | 'wrong_org' | 'fingerprint_mismatch' | 'bad_signature' | 'stale_generation'

export type PeerKeyVerdict = { ok: true; peer: VerifiedPeer } | { ok: false; reason: PeerKeyRejection }

export type PeerKeyContext = {
    bundle: ConfigurationBundle
    /** Highest generation accepted so far, if any. */
    lastSeenGeneration?: number
    /** After PEER_REJOINED the peer has a new key: only a strictly newer generation is acceptable. */
    requireNewer?: boolean
}

export const verifyPeerKey = (blob: PeerKeyResponse, context: PeerKeyContext): PeerKeyVerdict => {
    const { bundle } = context
    if (blob.studyId !== bundle.studyId) return { ok: false, reason: 'wrong_study' }
    if (blob.legId !== bundle.legId) return { ok: false, reason: 'wrong_leg' }
    if (blob.orgSlug !== bundle.peerOrgSlug) return { ok: false, reason: 'wrong_org' }

    const publicKey = Buffer.from(blob.publicKey, 'base64url')
    const popKey = Buffer.from(blob.popKey, 'base64url')
    if (fingerprintOf(publicKey, popKey) !== blob.fingerprint) return { ok: false, reason: 'fingerprint_mismatch' }

    const signed = verifyKeyBlobSignature(
        bundle.peerOrgPublicKey,
        {
            studyId: blob.studyId,
            jobId: blob.jobId,
            legId: blob.legId,
            connectionId: blob.connectionId,
            publicKey,
            popKey,
        },
        Buffer.from(blob.keySignature, 'base64url'),
    )
    if (!signed) return { ok: false, reason: 'bad_signature' }

    if (context.lastSeenGeneration !== undefined) {
        const floor = context.requireNewer ? context.lastSeenGeneration + 1 : context.lastSeenGeneration
        if (blob.generation < floor) return { ok: false, reason: 'stale_generation' }
    }

    return { ok: true, peer: { publicKey, connectionId: blob.connectionId, generation: blob.generation } }
}
