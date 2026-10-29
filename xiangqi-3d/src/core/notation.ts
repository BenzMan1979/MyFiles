import { Board, FILES, Move, Piece, PieceType, Side, fileOf, rankOf } from './types';
import { forward } from './rules';

export const PIECE_NAMES: Record<Side, Record<PieceType, string>> = {
  red: { k: '帥', a: '仕', b: '相', r: '俥', n: '傌', c: '炮', p: '兵' },
  black: { k: '將', a: '士', b: '象', r: '車', n: '馬', c: '砲', p: '卒' },
};

const RED_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BLACK_DIGITS = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
const ORDINALS = ['一', '二', '三', '四', '五'];

const digit = (side: Side, n: number) => (side === 'red' ? RED_DIGITS : BLACK_DIGITS)[n];

/** File number as the player reads it: each side counts 1..9 from its own right hand. */
const fileNumber = (side: Side, x: number) => (side === 'red' ? FILES - x : x + 1);

/** Chinese move notation such as 炮二平五 / 馬８進７ / 前俥進一. Call with the board *before* the move. */
export function moveToChinese(board: Board, move: Move): string {
  const piece = board[move.from] as Piece;
  const { side, type } = piece;
  const name = PIECE_NAMES[side][type];
  const x0 = fileOf(move.from);
  const y0 = rankOf(move.from);
  const x1 = fileOf(move.to);
  const y1 = rankOf(move.to);
  const f = forward(side);

  // Same-type pieces sharing this file decide whether a 前/中/後 prefix replaces the file number.
  const sameFile: number[] = [];
  for (let y = 0; y < board.length / FILES; y++) {
    const p = board[y * FILES + x0];
    if (p && p.side === side && p.type === type) sameFile.push(y);
  }
  sameFile.sort((a, b) => (b - a) * f); // most advanced first

  let head: string;
  if (sameFile.length < 2 || type === 'k' || type === 'a' || type === 'b') {
    head = name + digit(side, fileNumber(side, x0));
  } else {
    const idx = sameFile.indexOf(y0);
    let prefix: string;
    if (sameFile.length === 2) prefix = idx === 0 ? '前' : '後';
    else if (sameFile.length === 3) prefix = ['前', '中', '後'][idx];
    else prefix = ORDINALS[idx];
    head = prefix + name;
  }

  const dy = (y1 - y0) * f;
  if (dy === 0) return `${head}平${digit(side, fileNumber(side, x1))}`;
  const action = dy > 0 ? '進' : '退';
  const straight = type === 'r' || type === 'c' || type === 'p' || type === 'k';
  const amount = straight ? Math.abs(dy) : fileNumber(side, x1);
  return `${head}${action}${digit(side, amount)}`;
}
