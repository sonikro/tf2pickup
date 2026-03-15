import fp from 'fastify-plugin'
import { logger } from '../../logger'
import { events } from '../../events'
import { configure } from '../rcon/configure'
import { GameState, type GameModel, type GameNumber } from '../../database/models/game.model'
import { GameEventType } from '../../database/models/game-event.model'
import { update } from '../update'
import { minutesToMilliseconds } from 'date-fns'
import { configuration } from '../../configuration'

const SUPERSEDED_ABORT_REASON = 'superseded'
const INTERRUPTED_ABORT_REASON = 'game-interrupted'

export default fp(
  // eslint-disable-next-line @typescript-eslint/require-await
  async () => {
    const configurators = new Map<GameNumber, AbortController>()

    async function configureExclusive(game: GameModel) {
      let controller: AbortController | undefined
      let timeout: AbortSignal | undefined
      try {
        configurators.get(game.number)?.abort(SUPERSEDED_ABORT_REASON)
        controller = new AbortController()
        const timeoutMs = game.gameServer?.pendingTaskId
          ? (await configuration.get('tf2_quick_server.timeout')) + minutesToMilliseconds(1)
          : minutesToMilliseconds(1)
        timeout = AbortSignal.timeout(timeoutMs)
        const signal = AbortSignal.any([controller.signal, timeout])
        configurators.set(game.number, controller)
        await configure(game, { signal })
      } catch (error) {
        if (controller && timeout && isExpectedAbort(controller, timeout)) {
          logger.warn(
            { gameNumber: game.number, reason: String(controller.signal.reason) },
            `configure cancelled for game #${game.number}`,
          )
          return
        }

        logger.error({ error }, `error configuring game #${game.number}`)
        events.emit('game:gameServerConfigureFailed', { game, error })
        try {
          await update(game.number, {
            $push: {
              events: {
                event: GameEventType.gameServerConfigureFailed,
                at: new Date(),
                error: error instanceof Error ? error.message : String(error),
              },
            },
          })
        } catch (updateError) {
          logger.error(
            { error: updateError },
            `failed to record configure failure for game #${game.number}`,
          )
        }
      } finally {
        if (controller && configurators.get(game.number) === controller) {
          configurators.delete(game.number)
        }
      }
    }

    events.on('game:gameServerAssigned', async ({ game }) => {
      await configureExclusive(game)
    })

    events.on('game:gameServerReinitializationRequested', async ({ game }) => {
      await configureExclusive(game)
    })

    // eslint-disable-next-line @typescript-eslint/require-await
    events.on('game:ended', async ({ game }) => {
      if (game.state === GameState.interrupted) {
        configurators.get(game.number)?.abort(INTERRUPTED_ABORT_REASON)
      }
    })
  },
  {
    name: 'auto configure',
    encapsulate: true,
  },
)

function isExpectedAbort(controller: AbortController, timeout: AbortSignal): boolean {
  return controller.signal.aborted && !timeout.aborted
}
