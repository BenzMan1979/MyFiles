import { HistoryEntry } from '../core/game';
import { EndReason, GameStatus, Side } from '../core/types';

export const SIDE_NAMES: Record<Side, string> = { red: '紅方', black: '黑方' };

const REASON_TEXT: Record<EndReason, string> = {
  checkmate: '將死',
  stalemate: '困斃（無子可動）',
  'perpetual-check': '長將判負',
  repetition: '重複局面，判和',
  'move-limit': '六十回合未吃子，判和',
  resign: '認輸',
};

export interface HudActions {
  newGame(): void;
  undo(): void;
  flipView(): void;
  toggleViewMode(): void;
  toggleAutoFlip(): boolean;
  resign(): void;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** The DOM overlay: turn indicator, move list, toolbar, banners and the result dialog. */
export class Hud {
  private readonly turn = $('#turn');
  private readonly moves = $<HTMLOListElement>('#moves');
  private readonly banner = $('#banner');
  private readonly dialog = $<HTMLDialogElement>('#result');
  private bannerTimer = 0;

  constructor(actions: HudActions) {
    const bind = (id: string, fn: () => void) => $(`#${id}`).addEventListener('click', fn);
    bind('btn-new', actions.newGame);
    bind('btn-undo', actions.undo);
    bind('btn-flip', actions.flipView);
    bind('btn-view', actions.toggleViewMode);
    bind('btn-resign', actions.resign);
    bind('btn-autoflip', () => {
      const on = actions.toggleAutoFlip();
      $('#btn-autoflip').classList.toggle('on', on);
      $('#btn-autoflip').setAttribute('aria-pressed', String(on));
    });
    bind('btn-again', () => {
      this.dialog.close();
      actions.newGame();
    });
    bind('btn-review', () => this.dialog.close());
    bind('btn-moves', () => document.body.classList.toggle('moves-open'));
  }

  setTurn(side: Side, inCheck: boolean) {
    this.turn.dataset.side = side;
    this.turn.querySelector('.label')!.textContent = `${SIDE_NAMES[side]}走棋`;
    this.turn.classList.toggle('check', inCheck);
  }

  setViewMode(mode: '3d' | 'top') {
    $('#btn-view').textContent = mode === '3d' ? '俯視' : '立體';
  }

  setHistory(history: HistoryEntry[]) {
    this.moves.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const li = document.createElement('li');
      const red = document.createElement('span');
      red.className = `mv ${history[i].piece.side}`;
      red.textContent = history[i].notation;
      li.append(red);
      if (history[i + 1]) {
        const black = document.createElement('span');
        black.className = `mv ${history[i + 1].piece.side}`;
        black.textContent = history[i + 1].notation;
        li.append(black);
      }
      this.moves.append(li);
    }
    this.moves.scrollTop = this.moves.scrollHeight;
    $('#btn-undo').toggleAttribute('disabled', history.length === 0);
  }

  /** Big calligraphy-style announcement in the middle of the screen. */
  flash(text: string, tone: 'check' | 'info' = 'info') {
    window.clearTimeout(this.bannerTimer);
    this.banner.textContent = text;
    this.banner.className = `show ${tone}`;
    this.bannerTimer = window.setTimeout(() => (this.banner.className = ''), 1400);
  }

  showResult(status: GameStatus) {
    if (status.state !== 'over') return;
    const title = status.winner ? `${SIDE_NAMES[status.winner]}勝` : '和棋';
    $('#result-title').textContent = title;
    $('#result-title').dataset.side = status.winner ?? 'draw';
    $('#result-reason').textContent = REASON_TEXT[status.reason];
    this.dialog.showModal();
  }

  hideResult() {
    if (this.dialog.open) this.dialog.close();
  }
}
