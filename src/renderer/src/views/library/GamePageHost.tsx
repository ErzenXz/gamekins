import { useGame } from '../../components/library/libraryData'
import { GamePage } from '../GamePage'

export default function GamePageHost({ gameKey }: { gameKey: string }): React.JSX.Element | null {
  const game = useGame(gameKey)
  return game ? <GamePage key={game.key} game={game} /> : null
}
