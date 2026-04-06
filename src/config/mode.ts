import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { config } from './index.js';

export type Mode = 'desk' | 'away';

interface ModeState {
  mode: Mode;
  lastUpdated: string;
}

const MODE_FILE = path.join(process.cwd(), 'data', 'mode.json');

class ModeManager extends EventEmitter {
  private currentMode: Mode;

  constructor() {
    super();
    this.currentMode = config.mode;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(MODE_FILE)) {
        const data = fs.readFileSync(MODE_FILE, 'utf-8');
        const state = JSON.parse(data) as ModeState;
        if (state.mode === 'desk' || state.mode === 'away') {
          this.currentMode = state.mode;
          console.log(`[Mode] Loaded from file: ${this.currentMode}`);
        }
      }
    } catch (error) {
      console.error('[Mode] Failed to load mode file:', error);
    }
  }

  private save(): void {
    try {
      const state: ModeState = {
        mode: this.currentMode,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(MODE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('[Mode] Failed to save mode file:', error);
    }
  }

  getMode(): Mode {
    return this.currentMode;
  }

  setMode(mode: Mode): void {
    if (this.currentMode === mode) {
      return;
    }

    const oldMode = this.currentMode;
    this.currentMode = mode;
    this.save();

    console.log(`[Mode] Changed: ${oldMode} -> ${mode}`);
    this.emit('modeChanged', { oldMode, newMode: mode });
  }

  isAwayMode(): boolean {
    return this.currentMode === 'away';
  }

  isDeskMode(): boolean {
    return this.currentMode === 'desk';
  }
}

export const modeManager = new ModeManager();
