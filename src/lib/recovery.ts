import type { BmaClient } from '@/lib/bma/client'
import type { Channel } from '@/lib/channel'
import type { Lifecycle } from '@/lib/lifecycle'
import { log } from '@/lib/logger'

// The recovery orchestrator (plan Phase 8): one place that says who re-fetches what, in what
// order, for each way a channel comes back (v2 §8).
//
// - Own socket drop, same identity: nothing to re-fetch. The relay client re-dials with the
//   pre-fetched token, the relay redelivers un-ACKed frames of the current epoch, and the delivery
//   layer re-offers its outbox (the relay appends idempotently). The Noise session survives.
// - PEER_REJOINED (the peer restarted with a new identity): the channel tears the session down
//   (CHANNEL_UP → RELAY_ATTACHED), the BMA client polls the directory until a STRICTLY newer
//   generation appears, verifies it against the pinned org key, and hands it to the channel, which
//   re-runs Noise_IK; the outbox is re-encrypted under the new epoch and re-sent.
// - Own restart (new process): the Setup App re-provisions; the peer sees PEER_REJOINED and does
//   the above. Our outbox is gone; the destination SDK re-issues the in-flight round by
//   correlationId, and a source replays its cached response.
// - Handshake never completes (initiator retries exhausted): the session cannot come up — ERRORED.

export const installRecovery = (deps: { channel: Channel; bma?: BmaClient; lifecycle: Lifecycle }): (() => void) => {
    const onPeerRejoined = (peerRole: 'source' | 'destination') => {
        log.info('recovery.peer_rejoined', { peerRole, hasDirectory: deps.bma !== undefined })
        deps.bma?.refetchPeerKey()
    }
    const onHandshakeFailed = (reason: string) => {
        deps.lifecycle.fail('ERRORED', `handshake: ${reason}`)
    }
    deps.channel.on('peerRejoined', onPeerRejoined)
    deps.channel.on('handshakeFailed', onHandshakeFailed)
    return () => {
        deps.channel.off('peerRejoined', onPeerRejoined)
        deps.channel.off('handshakeFailed', onHandshakeFailed)
    }
}
