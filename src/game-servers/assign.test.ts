import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tf2-quick-server', () => ({
  tf2QuickServer: {
    assign: vi.fn(),
  },
}))

vi.mock('../static-game-servers', () => ({
  staticGameServers: {
    assign: vi.fn(),
  },
}))

vi.mock('../serveme-tf', () => ({
  servemeTf: {
    assign: vi.fn(),
  },
}))

vi.mock('../games', () => ({
  games: {
    update: vi.fn().mockResolvedValue({ number: 1, gameServer: { name: 'test' } }),
    findOne: vi.fn(),
  },
}))

vi.mock('../events', () => ({
  events: { emit: vi.fn() },
}))

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

vi.mock('../errors', () => ({
  errors: {
    badRequest: (msg: string) => new Error(msg),
    internalServerError: (msg: string) => new Error(msg),
  },
}))

import { assign } from './assign'
import { tf2QuickServer } from '../tf2-quick-server'
import { staticGameServers } from '../static-game-servers'
import { servemeTf } from '../serveme-tf'
import { games } from '../games'
import { events } from '../events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeGame = { number: 1 } as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeServer = { id: 'srv', name: 'test', provider: 'tf2quickserver' } as any

describe('assign() with selected tf2QuickServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tf2QuickServer.assign).mockResolvedValue(fakeServer)
    vi.mocked(games.findOne).mockResolvedValue({ number: 1 } as never)
  })

  it('calls tf2QuickServer.assign with serverId when value is tf2QuickServer:{id}', async () => {
    await assign(fakeGame, 'tf2QuickServer:server-abc123')
    expect(tf2QuickServer.assign).toHaveBeenCalledWith({ serverId: 'server-abc123' })
    expect(staticGameServers.assign).not.toHaveBeenCalled()
    expect(servemeTf.assign).not.toHaveBeenCalled()
  })

  it('calls tf2QuickServer.assign with region when value is tf2QuickServer:new:{region}', async () => {
    await assign(fakeGame, 'tf2QuickServer:new:eu-frankfurt-1')
    expect(tf2QuickServer.assign).toHaveBeenCalledWith({ region: 'eu-frankfurt-1' })
  })

  it('throws for unknown game server selection', async () => {
    await expect(assign(fakeGame, 'unknown:foo')).rejects.toThrow('unknown game server selection')
  })
})

describe('assign() auto-assignment idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(staticGameServers.assign).mockRejectedValue(new Error('no static'))
    vi.mocked(servemeTf.assign).mockRejectedValue(new Error('no serveme'))
    vi.mocked(tf2QuickServer.assign).mockResolvedValue(fakeServer)
    vi.mocked(games.update).mockResolvedValue({ number: 1, gameServer: fakeServer } as never)
  })

  it('does not create two TF2QS servers when assignment is triggered concurrently for the same game', async () => {
    const inMemoryGameState: { number: number; gameServer?: unknown } = { number: 1 }

    vi.mocked(games.findOne).mockImplementation(async () => ({ ...inMemoryGameState }) as never)
    vi.mocked(games.update).mockImplementation(async (_number, update) => {
      if ('$set' in update && update.$set?.gameServer) {
        inMemoryGameState.gameServer = update.$set.gameServer
      }
      return { ...inMemoryGameState } as never
    })

    await Promise.all([assign(fakeGame), assign(fakeGame)])

    expect(tf2QuickServer.assign).toHaveBeenCalledTimes(1)
    expect(events.emit).toHaveBeenCalledTimes(1)
  })

  it('skips auto-assignment when a serveme server is already assigned in DB', async () => {
    vi.mocked(games.findOne).mockResolvedValue({
      number: 1,
      gameServer: {
        provider: 'servemeTf',
        id: '1234',
        name: 'serveme #1',
      },
    } as never)

    await assign(fakeGame)

    expect(staticGameServers.assign).not.toHaveBeenCalled()
    expect(servemeTf.assign).not.toHaveBeenCalled()
    expect(tf2QuickServer.assign).not.toHaveBeenCalled()
    expect(games.update).not.toHaveBeenCalled()
    expect(events.emit).not.toHaveBeenCalled()
  })

  it('skips auto-assignment when a pending TF2QS task is already assigned in DB', async () => {
    vi.mocked(games.findOne).mockResolvedValue({
      number: 1,
      gameServer: {
        provider: 'tf2QuickServer',
        id: 'task-123',
        name: 'A new quick server',
        pendingTaskId: 'task-123',
      },
    } as never)

    await assign(fakeGame)

    expect(tf2QuickServer.assign).not.toHaveBeenCalled()
    expect(games.update).not.toHaveBeenCalled()
    expect(events.emit).not.toHaveBeenCalled()
  })
})
