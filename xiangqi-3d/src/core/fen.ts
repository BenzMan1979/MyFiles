import { Board, FILES, Piece, PieceType, RANKS, Side, sq } from './types';

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

const PIECE_TYPES = new Set<string>(['k', 'a', 'b', 'r', 'n', 'c', 'p']);

/** Parses the board and side-to-move fields of a xiangqi FEN (uppercase = red, ranks listed from black's side). */
export function parseFen(fen: string): { board: Board; turn: Side } {
  const [placement, turnField = 'w'] = fen.trim().split(/\s+/);
  const rows = placement.split('/');
  if (rows.length !== RANKS) throw new Error(`FEN must have ${RANKS} ranks: ${fen}`);

  const board: Board = new Array(FILES * RANKS).fill(null);
  const counters = new Map<string, number>();

  rows.forEach((row, i) => {
    const y = RANKS - 1 - i;
    let x = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        x += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      if (!PIECE_TYPES.has(lower)) throw new Error(`Unknown piece "${ch}" in FEN: ${fen}`);
      const side: Side = ch === lower ? 'black' : 'red';
      const key = `${side}-${lower}`;
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      board[sq(x, y)] = { side, type: lower as PieceType, id: `${key}-${n}` };
      x++;
    }
    if (x !== FILES) throw new Error(`Rank ${i} of FEN does not have ${FILES} files: ${fen}`);
  });

  return { board, turn: turnField === 'b' ? 'black' : 'red' };
}

export function pieceChar(p: Piece): string {
  return p.side === 'red' ? p.type.toUpperCase() : p.type;
}

export function toFen(board: Board, turn: Side): string {
  const rows: string[] = [];
  for (let y = RANKS - 1; y >= 0; y--) {
    let row = '';
    let empty = 0;
    for (let x = 0; x < FILES; x++) {
      const p = board[sq(x, y)];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += pieceChar(p);
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn === 'red' ? 'w' : 'b'}`;
}
