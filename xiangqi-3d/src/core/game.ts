import { START_FEN, parseFen, toFen } from './fen';
import { moveToChinese } from './notation';
import { allLegalMoves, applyMove, isInCheck, legalMovesFrom } from './rules';
import { Board, GameStatus, Move, Piece, Side, Square, opponent } from './types';

export interface HistoryEntry {
  move: Move;
  piece: Piece;
  captured: Piece | null;
  /** Whether this move put the opponent in check. */
  givesCheck: boolean;
  notation: string;
  /** Plies since the last capture, before this move. */
  prevQuietPlies: number;
}

/** 自然限著：60 回合（120 步）無吃子判和。 */
export const QUIET_PLY_LIMIT = 120;

export class Game {
  board: Board;
  turn: Side;
  history: HistoryEntry[] = [];
  status: GameStatus = { state: 'playing' };
  private quietPlies = 0;
  /** Position key after each ply; index 0 is the starting position. */
  private positions: string[] = [];

  constructor(fen: string = START_FEN) {
    const { board, turn } = parseFen(fen);
    this.board = board;
    this.turn = turn;
    this.positions.push(toFen(board, turn));
  }

  get isOver() {
    return this.status.state === 'over';
  }

  get lastMove(): HistoryEntry | undefined {
    return this.history[this.history.length - 1];
  }

  inCheck(side: Side = this.turn) {
    return isInCheck(this.board, side);
  }

  legalMovesFrom(from: Square): Square[] {
    if (this.isOver || this.board[from]?.side !== this.turn) return [];
    return legalMovesFrom(this.board, from);
  }

  legalMoves(): Move[] {
    return this.isOver ? [] : allLegalMoves(this.board, this.turn);
  }

  /** Plays a move for the side to move. Returns the history entry, or null if illegal. */
  move(from: Square, to: Square): HistoryEntry | null {
    if (!this.legalMovesFrom(from).includes(to)) return null;

    const piece = this.board[from] as Piece;
    const captured = this.board[to];
    const notation = moveToChinese(this.board, { from, to });
    this.board = applyMove(this.board, { from, to });
    this.turn = opponent(this.turn);

    const entry: HistoryEntry = {
      move: { from, to },
      piece,
      captured,
      givesCheck: isInCheck(this.board, this.turn),
      notation,
      prevQuietPlies: this.quietPlies,
    };
    this.quietPlies = captured ? 0 : this.quietPlies + 1;
    this.history.push(entry);
    this.positions.push(toFen(this.board, this.turn));
    this.status = this.evaluateStatus();
    return entry;
  }

  undo(): HistoryEntry | null {
    const entry = this.history.pop();
    if (!entry) return null;
    const { from, to } = entry.move;
    this.board = this.board.slice();
    this.board[from] = entry.piece;
    this.board[to] = entry.captured;
    this.turn = entry.piece.side;
    this.quietPlies = entry.prevQuietPlies;
    this.positions.pop();
    this.status = { state: 'playing' };
    return entry;
  }

  resign(side: Side) {
    if (!this.isOver) this.status = { state: 'over', winner: opponent(side), reason: 'resign' };
  }

  fen() {
    return toFen(this.board, this.turn);
  }

  private evaluateStatus(): GameStatus {
    const toMove = this.turn;
    if (allLegalMoves(this.board, toMove).length === 0) {
      // In xiangqi having no legal move loses, whether or not in check.
      return {
        state: 'over',
        winner: opponent(toMove),
        reason: isInCheck(this.board, toMove) ? 'checkmate' : 'stalemate',
      };
    }

    const repetition = this.repetitionResult();
    if (repetition) return repetition;

    if (this.quietPlies >= QUIET_PLY_LIMIT) {
      return { state: 'over', winner: null, reason: 'move-limit' };
    }
    return { state: 'playing' };
  }

  /**
   * Third occurrence of the same position: a side that checked on every one of its moves
   * in the cycle loses (長將判負); otherwise the game is drawn.
   * Simplified — 長捉 (perpetual chasing) is not judged yet.
   */
  private repetitionResult(): GameStatus | null {
    const current = this.positions[this.positions.length - 1];
    const occurrences: number[] = [];
    this.positions.forEach((p, i) => p === current && occurrences.push(i));
    if (occurrences.length < 3) return null;

    const cycleStart = occurrences[occurrences.length - 2];
    const cycle = this.history.slice(cycleStart); // moves leading from the previous occurrence to now
    const perpetual = (side: Side) => {
      const own = cycle.filter((h) => h.piece.side === side);
      return own.length > 0 && own.every((h) => h.givesCheck);
    };
    const redChecks = perpetual('red');
    const blackChecks = perpetual('black');
    if (redChecks !== blackChecks) {
      return { state: 'over', winner: redChecks ? 'black' : 'red', reason: 'perpetual-check' };
    }
    return { state: 'over', winner: null, reason: 'repetition' };
  }
}
