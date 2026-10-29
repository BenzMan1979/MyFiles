import { describe, expect, it } from 'vitest';
import { START_FEN, parseFen, toFen } from './fen';
import { Game } from './game';
import { moveToChinese } from './notation';
import { allLegalMoves, applyMove, isInCheck, legalMovesFrom } from './rules';
import { Board, Side, opponent, sq } from './types';

function perft(board: Board, side: Side, depth: number): number {
  if (depth === 0) return 1;
  const moves = allLegalMoves(board, side);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(applyMove(board, m), opponent(side), depth - 1);
  return n;
}

describe('FEN', () => {
  it('round-trips the start position', () => {
    const { board, turn } = parseFen(START_FEN);
    expect(toFen(board, turn)).toBe(START_FEN);
  });

  it('gives every piece a unique id', () => {
    const ids = parseFen(START_FEN).board.filter(Boolean).map((p) => p!.id);
    expect(new Set(ids).size).toBe(32);
  });
});

describe('move generation', () => {
  it('matches known perft counts from the start position', () => {
    const { board } = parseFen(START_FEN);
    expect(perft(board, 'red', 1)).toBe(44);
    expect(perft(board, 'red', 2)).toBe(1920);
    expect(perft(board, 'red', 3)).toBe(79666);
  });

  it('blocks a horse whose leg is occupied (蹩馬腿)', () => {
    const { board } = parseFen('3k5/9/9/9/9/9/9/9/4P4/3NK4 w');
    // Horse on (3,0); pawn at (4,1) does not block, but nothing blocks the upward leg (3,1).
    expect(legalMovesFrom(board, sq(3, 0)).sort()).toEqual([sq(1, 1), sq(2, 2), sq(4, 2)].sort());
    const blocked = parseFen('3k5/9/9/9/9/9/9/9/3P5/3NK4 w').board;
    // Leg (3,1) occupied: no moves up two ranks; sideways leg (2,0)/(4,0) decide the flat jumps.
    expect(legalMovesFrom(blocked, sq(3, 0))).toEqual([sq(1, 1)]);
  });

  it('blocks an elephant whose eye is occupied (塞象眼) and keeps it home', () => {
    const { board } = parseFen('3k5/9/9/9/9/2B6/9/9/9/4K4 w');
    // Elephant on (2,4): the two squares across the river are off limits.
    expect(legalMovesFrom(board, sq(2, 4)).sort()).toEqual([sq(0, 2), sq(4, 2)].sort());
    const eyed = parseFen('3k5/9/9/9/9/2B6/3p5/9/9/4K4 w').board;
    expect(legalMovesFrom(eyed, sq(2, 4))).toEqual([sq(0, 2)]);
  });

  it('lets a cannon capture only over exactly one screen', () => {
    const { board } = parseFen('4k4/9/9/9/9/9/9/9/5K3/C1p1r4 w');
    const moves = legalMovesFrom(board, sq(0, 0));
    expect(moves).toContain(sq(1, 0));
    expect(moves).not.toContain(sq(2, 0)); // cannot capture the screen itself
    expect(moves).toContain(sq(4, 0)); // jumps the pawn to capture the rook
  });

  it('forbids exposing the kings to each other (將帥對臉)', () => {
    const { board } = parseFen('4k4/9/9/9/9/9/9/9/4R4/4K4 w');
    // The rook is pinned on the e-file: any sideways move would leave the kings facing.
    const moves = legalMovesFrom(board, sq(4, 1));
    expect(moves.every((to) => to % 9 === 4)).toBe(true);
  });

  it('detects a check from a horse but not through a blocked leg', () => {
    expect(isInCheck(parseFen('3k5/9/4N4/9/9/9/9/9/9/5K3 b').board, 'black')).toBe(true);
    expect(isInCheck(parseFen('3k5/4P4/4N4/9/9/9/9/9/9/5K3 b').board, 'black')).toBe(false);
  });

  it('lets a pawn move sideways only after crossing the river', () => {
    const home = parseFen('4k4/9/9/9/9/9/4P4/9/9/3K5 w').board;
    expect(legalMovesFrom(home, sq(4, 3))).toEqual([sq(4, 4)]);
    const crossed = parseFen('4k4/9/9/9/4P4/9/9/9/9/3K5 w').board;
    expect(legalMovesFrom(crossed, sq(4, 5)).sort()).toEqual([sq(4, 6), sq(3, 5), sq(5, 5)].sort());
  });
});

describe('game status', () => {
  it('detects checkmate', () => {
    const game = new Game('3k5/1R7/9/9/9/9/9/9/R8/4K4 w');
    game.move(sq(0, 1), sq(0, 9));
    expect(game.status).toEqual({ state: 'over', winner: 'red', reason: 'checkmate' });
  });

  it('treats having no legal move as a loss (困斃)', () => {
    const game = new Game('3k5/9/8R/9/9/9/9/9/9/4K4 w');
    game.move(sq(8, 7), sq(8, 8));
    expect(game.status).toEqual({ state: 'over', winner: 'red', reason: 'stalemate' });
  });

  it('draws on threefold repetition', () => {
    const game = new Game();
    for (let i = 0; i < 2; i++) {
      game.move(sq(0, 0), sq(0, 1));
      game.move(sq(0, 9), sq(0, 8));
      game.move(sq(0, 1), sq(0, 0));
      game.move(sq(0, 8), sq(0, 9));
    }
    expect(game.status).toEqual({ state: 'over', winner: null, reason: 'repetition' });
  });

  it('makes the perpetually checking side lose (長將判負)', () => {
    const game = new Game('3k5/R8/9/9/9/9/9/9/9/5K3 w');
    for (let i = 0; i < 2; i++) {
      expect(game.move(sq(0, 8), sq(0, 9))?.givesCheck).toBe(true);
      game.move(sq(3, 9), sq(3, 8));
      expect(game.move(sq(0, 9), sq(0, 8))?.givesCheck).toBe(true);
      game.move(sq(3, 8), sq(3, 9));
    }
    expect(game.status).toEqual({ state: 'over', winner: 'black', reason: 'perpetual-check' });
  });

  it('rejects illegal moves and moves of the wrong side', () => {
    const game = new Game();
    expect(game.move(sq(0, 9), sq(0, 8))).toBeNull(); // black cannot move first
    expect(game.move(sq(1, 0), sq(1, 2))).toBeNull(); // horse cannot move straight
  });

  it('undo restores the board, turn and status', () => {
    const game = new Game('3k5/1R7/9/9/9/9/9/9/R8/4K4 w');
    const before = game.fen();
    game.move(sq(0, 1), sq(0, 9));
    game.undo();
    expect(game.fen()).toBe(before);
    expect(game.status.state).toBe('playing');
    expect(game.turn).toBe('red');
  });

  it('undo restores captured pieces', () => {
    const game = new Game();
    game.move(sq(1, 2), sq(1, 9)); // 炮八進七 captures the horse
    expect(game.lastMove?.captured?.type).toBe('n');
    game.undo();
    expect(game.fen()).toBe(START_FEN);
  });
});

describe('Chinese notation', () => {
  const { board } = parseFen(START_FEN);
  it('writes red moves with Chinese numerals', () => {
    expect(moveToChinese(board, { from: sq(7, 2), to: sq(4, 2) })).toBe('炮二平五');
    expect(moveToChinese(board, { from: sq(7, 0), to: sq(6, 2) })).toBe('傌二進三');
    expect(moveToChinese(board, { from: sq(8, 0), to: sq(8, 1) })).toBe('俥一進一');
  });

  it('writes black moves with full-width digits', () => {
    expect(moveToChinese(board, { from: sq(7, 9), to: sq(6, 7) })).toBe('馬８進７');
    expect(moveToChinese(board, { from: sq(2, 6), to: sq(2, 5) })).toBe('卒３進１');
  });

  it('uses 前/後 for two same pieces on one file', () => {
    const b = parseFen('4k4/9/9/9/9/9/9/R8/9/R3K4 w').board;
    expect(moveToChinese(b, { from: sq(0, 2), to: sq(0, 5) })).toBe('前俥進三');
    expect(moveToChinese(b, { from: sq(0, 0), to: sq(1, 0) })).toBe('後俥平八');
  });
});
