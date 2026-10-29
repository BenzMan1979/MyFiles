import * as THREE from 'three';
import { Game } from './core/game';
import { findKing } from './core/rules';
import { Square, opponent } from './core/types';
import { BoardView, squareToWorld } from './render/boardView';
import { Stage } from './render/stage';
import { PIECE_FONT } from './render/textures';
import { Hud, SIDE_NAMES } from './ui/hud';
import './style.css';

/** Local two-player controller: input → rules → animation → HUD. */
class App {
  private game = new Game();
  private readonly stage: Stage;
  private readonly view: BoardView;
  private readonly hud: Hud;
  private selected: Square | null = null;
  private busy = false;
  private autoFlip = false;

  constructor() {
    this.stage = new Stage(document.getElementById('stage')!);
    this.view = new BoardView(this.stage);
    this.hud = new Hud({
      newGame: () => this.newGame(),
      undo: () => this.undo(),
      flipView: () => this.flipView(),
      toggleViewMode: () => this.toggleViewMode(),
      toggleAutoFlip: () => (this.autoFlip = !this.autoFlip),
      resign: () => this.resign(),
    });
    this.bindPointer();
    this.newGame();
    if (new URLSearchParams(location.search).has('debug')) this.exposeDebugHooks();
  }

  /** Lets browser automation find the screen position of a board point. */
  private exposeDebugHooks() {
    Object.assign(window, {
      __project: (x: number, y: number) => {
        const p = squareToWorld(y * 9 + x).project(this.stage.camera);
        const canvas = this.stage.renderer.domElement;
        return { x: ((p.x + 1) / 2) * canvas.clientWidth, y: ((1 - p.y) / 2) * canvas.clientHeight };
      },
      __game: () => this.game,
    });
  }

  private newGame() {
    this.game = new Game();
    this.selected = null;
    this.hud.hideResult();
    this.view.setBoard(this.game.board);
    this.refresh();
    if (this.stage.side !== 'red') this.flipView();
  }

  private refresh() {
    const inCheck = !this.game.isOver && this.game.inCheck();
    this.hud.setTurn(this.game.turn, inCheck);
    this.hud.setHistory(this.game.history);
    this.view.setLastMove(this.game.lastMove);
    this.view.setCheck(inCheck ? findKing(this.game.board, this.game.turn) : null);
  }

  private async play(from: Square, to: Square) {
    const entry = this.game.move(from, to);
    if (!entry) return;
    this.busy = true;
    this.selected = null;
    await this.view.animateMove(entry);
    this.refresh();
    if (this.game.isOver) {
      this.hud.showResult(this.game.status);
    } else {
      if (entry.givesCheck) this.hud.flash('將軍！', 'check');
      if (this.autoFlip) await this.turnViewTo(this.game.turn);
    }
    this.busy = false;
  }

  private async undo() {
    if (this.busy) return;
    const entry = this.game.undo();
    if (!entry) return;
    this.busy = true;
    this.hud.hideResult();
    this.selected = null;
    await this.view.animateUndo(entry);
    this.refresh();
    if (this.autoFlip) await this.turnViewTo(this.game.turn);
    this.busy = false;
  }

  private resign() {
    if (this.busy || this.game.isOver) return;
    if (!confirm(`${SIDE_NAMES[this.game.turn]}確定要認輸嗎？`)) return;
    this.game.resign(this.game.turn);
    this.refresh();
    this.hud.showResult(this.game.status);
  }

  private flipView() {
    void this.turnViewTo(opponent(this.stage.side));
  }

  private async turnViewTo(side: typeof this.stage.side) {
    if (side === this.stage.side) return;
    await Promise.all([this.stage.setView(side), this.view.setFacing(side)]);
  }

  private toggleViewMode() {
    const mode = this.stage.mode === '3d' ? 'top' : '3d';
    this.hud.setViewMode(mode);
    void this.stage.setView(this.stage.side, mode);
  }

  private onSquareClicked(s: Square | null) {
    if (this.busy || this.game.isOver) return;
    const piece = s === null ? null : this.game.board[s];

    if (s !== null && piece?.side === this.game.turn) {
      if (this.selected === s) {
        this.selected = null;
        this.view.select(null);
      } else {
        this.selected = s;
        this.view.select(s, this.game.board, this.game.legalMovesFrom(s));
      }
      return;
    }
    if (this.selected !== null && s !== null && this.game.legalMovesFrom(this.selected).includes(s)) {
      void this.play(this.selected, s);
      return;
    }
    this.selected = null;
    this.view.select(null);
  }

  private bindPointer() {
    const canvas = this.stage.renderer.domElement;
    const ndc = (e: PointerEvent) =>
      new THREE.Vector2((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);

    // Distinguish a click from an orbit drag.
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 8 && quick) this.onSquareClicked(this.view.pick(ndc(e)));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const s = this.view.pick(ndc(e));
      const piece = s === null ? null : this.game.board[s];
      const actionable = !this.busy && !this.game.isOver && piece?.side === this.game.turn;
      this.view.setHover(actionable ? piece!.id : null);
      const target = this.selected !== null && s !== null && this.game.legalMovesFrom(this.selected).includes(s);
      canvas.style.cursor = actionable || target ? 'pointer' : '';
    });
  }
}

// Piece faces are drawn onto canvases, so wait for the web font before building them.
async function boot() {
  try {
    await Promise.race([
      document.fonts.load(`900 64px ${PIECE_FONT}`, '帥將仕士相象俥車傌馬炮砲兵卒楚河漢界'),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {
    // Fall back to whatever serif font the system has.
  }
  new App();
  document.body.classList.add('ready');
}

void boot();
