export type Side = 'red' | 'black';

/** k 將帥, a 士仕, b 象相, r 車, n 馬, c 炮, p 兵卒 — same letters as xiangqi FEN. */
export type PieceType = 'k' | 'a' | 'b' | 'r' | 'n' | 'c' | 'p';

export interface Piece {
  side: Side;
  type: PieceType;
  /** Stable identity across moves, e.g. "red-r-0". Used by the renderer and for faction character mapping. */
  id: string;
}

/**
 * Square index = y * 9 + x.
 * x: file 0..8, left to right as seen by red.
 * y: rank 0..9, 0 is red's back rank, 9 is black's back rank.
 */
export type Square = number;

export type Board = (Piece | null)[];

export interface Move {
  from: Square;
  to: Square;
}

export type EndReason =
  | 'checkmate' // 將死
  | 'stalemate' // 困斃
  | 'perpetual-check' // 長將判負
  | 'repetition' // 重複局面和棋
  | 'move-limit' // 自然限著
  | 'resign'; // 認輸

export type GameStatus =
  | { state: 'playing' }
  | { state: 'over'; winner: Side | null; reason: EndReason };

export const FILES = 9;
export const RANKS = 10;

export const sq = (x: number, y: number): Square => y * FILES + x;
export const fileOf = (s: Square): number => s % FILES;
export const rankOf = (s: Square): number => Math.floor(s / FILES);
export const opponent = (side: Side): Side => (side === 'red' ? 'black' : 'red');
