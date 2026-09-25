import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRoom, joinRoom, startGame, toPublicRoom } from './rooms.js'

describe('lobby joins', () => {
  it('lets host + three players join (start needs 2 non-host)', () => {
    const { room, playerId: hostId } = createRoom('Host', 'sock-host', 'sv')
    const code = room.code

    const p1 = joinRoom(code, 'Ada', 'sock-1')
    const p2 = joinRoom(code, 'Bo', 'sock-2')
    const p3 = joinRoom(code, 'Cia', 'sock-3')

    assert.ok(!('error' in p1), 'player 1 should join')
    assert.ok(!('error' in p2), 'player 2 should join')
    assert.ok(!('error' in p3), `player 3 should join, got ${'error' in p3 ? p3.error : ''}`)

    if ('error' in p1 || 'error' in p2 || 'error' in p3) return

    const pub = toPublicRoom(p3.room, p3.playerId)
    const seated = pub.players.filter((p) => !p.spectator && p.id !== pub.hostId)
    assert.equal(seated.length, 3)

    const started = startGame(code, hostId)
    assert.ok(!('error' in started), `start should work with 3 players`)
  })

  it('starts with host + two players (same party size as when host played)', () => {
    const { room, playerId: hostId } = createRoom('Host', 'sock-host-2', 'sv')
    const code = room.code
    assert.ok(!('error' in joinRoom(code, 'Ada', 'sock-a')))
    assert.ok(!('error' in joinRoom(code, 'Bo', 'sock-b')))
    const started = startGame(code, hostId)
    assert.ok(!('error' in started), `start should work with 2 non-host players: ${'error' in started ? started.error : ''}`)
  })

  it('does not let disconnected ghosts block the third seat', () => {
    const { room } = createRoom('Host', 'sock-host', 'sv')
    const code = room.code

    assert.ok(!('error' in joinRoom(code, 'Ada', 'sock-1')))
    const ghost = joinRoom(code, 'Ghost', 'sock-ghost')
    assert.ok(!('error' in ghost))
    if ('error' in ghost) return

    // Simulate abandon without reclaim: mark disconnected but leave the seat.
    const g = room.players.find((p) => p.id === ghost.playerId)
    assert.ok(g)
    g!.connected = false

    const p2 = joinRoom(code, 'Bo', 'sock-2')
    const p3 = joinRoom(code, 'Cia', 'sock-3')
    assert.ok(!('error' in p2))
    assert.ok(!('error' in p3), `third join blocked: ${'error' in p3 ? p3.error : ''}`)
  })

  it('reclaims a disconnected seat by the same name', () => {
    const { room } = createRoom('Host', 'sock-host', 'sv')
    const code = room.code
    const first = joinRoom(code, 'Ada', 'sock-ada-1')
    assert.ok(!('error' in first))
    if ('error' in first) return

    const ada = room.players.find((p) => p.id === first.playerId)!
    ada.connected = false

    const again = joinRoom(code, 'Ada', 'sock-ada-2')
    assert.ok(!('error' in again))
    if ('error' in again) return
    assert.equal(again.playerId, first.playerId)
    assert.equal(room.players.filter((p) => p.name === 'Ada').length, 1)
  })

  it('starts with host playing along + one guest', () => {
    const { room, playerId: hostId } = createRoom('Host', 'sock-host-play', 'sv')
    const code = room.code
    room.hostPlays = true
    assert.ok(!('error' in joinRoom(code, 'Ada', 'sock-ada-play')))
    const started = startGame(code, hostId)
    assert.ok(
      !('error' in started),
      `start should work with host playing + 1 guest: ${'error' in started ? started.error : ''}`,
    )
  })
})
