import { describe, it, expect } from 'vitest';
import {
  classifyTool,
  shouldIntercept,
  shouldPassthrough,
  INTERCEPT_TOOLS,
  PASSTHROUGH_TOOLS,
} from '../src/filters/toolFilter.js';

describe('Tool Filter', () => {
  describe('INTERCEPT_TOOLS', () => {
    it('should contain write_to_file', () => {
      expect(INTERCEPT_TOOLS.has('write_to_file')).toBe(true);
    });

    it('should contain create_file', () => {
      expect(INTERCEPT_TOOLS.has('create_file')).toBe(true);
    });

    it('should contain delete_file', () => {
      expect(INTERCEPT_TOOLS.has('delete_file')).toBe(true);
    });

    it('should contain execute_command', () => {
      expect(INTERCEPT_TOOLS.has('execute_command')).toBe(true);
    });

    it('should contain computer_use', () => {
      expect(INTERCEPT_TOOLS.has('computer_use')).toBe(true);
    });
  });

  describe('PASSTHROUGH_TOOLS', () => {
    it('should contain read_file', () => {
      expect(PASSTHROUGH_TOOLS.has('read_file')).toBe(true);
    });

    it('should contain list_directory', () => {
      expect(PASSTHROUGH_TOOLS.has('list_directory')).toBe(true);
    });

    it('should contain search_files', () => {
      expect(PASSTHROUGH_TOOLS.has('search_files')).toBe(true);
    });

    it('should contain grep_search', () => {
      expect(PASSTHROUGH_TOOLS.has('grep_search')).toBe(true);
    });

    it('should contain web_search', () => {
      expect(PASSTHROUGH_TOOLS.has('web_search')).toBe(true);
    });
  });

  describe('classifyTool', () => {
    describe('intercept tools', () => {
      it('should classify write_to_file as intercept', () => {
        expect(classifyTool('write_to_file')).toBe('intercept');
      });

      it('should classify create_file as intercept', () => {
        expect(classifyTool('create_file')).toBe('intercept');
      });

      it('should classify delete_file as intercept', () => {
        expect(classifyTool('delete_file')).toBe('intercept');
      });

      it('should classify apply_diff as intercept', () => {
        expect(classifyTool('apply_diff')).toBe('intercept');
      });

      it('should classify str_replace as intercept', () => {
        expect(classifyTool('str_replace')).toBe('intercept');
      });

      it('should classify insert_content as intercept', () => {
        expect(classifyTool('insert_content')).toBe('intercept');
      });

      it('should classify execute_command as intercept', () => {
        expect(classifyTool('execute_command')).toBe('intercept');
      });

      it('should classify run_terminal_cmd as intercept', () => {
        expect(classifyTool('run_terminal_cmd')).toBe('intercept');
      });

      it('should classify computer_use as intercept', () => {
        expect(classifyTool('computer_use')).toBe('intercept');
      });
    });

    describe('passthrough tools', () => {
      it('should classify read_file as passthrough', () => {
        expect(classifyTool('read_file')).toBe('passthrough');
      });

      it('should classify list_directory as passthrough', () => {
        expect(classifyTool('list_directory')).toBe('passthrough');
      });

      it('should classify search_files as passthrough', () => {
        expect(classifyTool('search_files')).toBe('passthrough');
      });

      it('should classify grep_search as passthrough', () => {
        expect(classifyTool('grep_search')).toBe('passthrough');
      });

      it('should classify web_search as passthrough', () => {
        expect(classifyTool('web_search')).toBe('passthrough');
      });

      it('should classify get_file_info as passthrough', () => {
        expect(classifyTool('get_file_info')).toBe('passthrough');
      });
    });

    describe('unknown tools', () => {
      it('should classify unknown tools as intercept (safe fallback)', () => {
        expect(classifyTool('unknown_tool')).toBe('intercept');
        expect(classifyTool('completely_random')).toBe('intercept');
        expect(classifyTool('')).toBe('intercept');
      });
    });
  });

  describe('shouldIntercept', () => {
    it('should return true for intercept tools', () => {
      expect(shouldIntercept('write_to_file')).toBe(true);
      expect(shouldIntercept('execute_command')).toBe(true);
    });

    it('should return false for passthrough tools', () => {
      expect(shouldIntercept('read_file')).toBe(false);
      expect(shouldIntercept('web_search')).toBe(false);
    });

    it('should return true for unknown tools', () => {
      expect(shouldIntercept('unknown')).toBe(true);
    });
  });

  describe('shouldPassthrough', () => {
    it('should return true for passthrough tools', () => {
      expect(shouldPassthrough('read_file')).toBe(true);
      expect(shouldPassthrough('web_search')).toBe(true);
    });

    it('should return false for intercept tools', () => {
      expect(shouldPassthrough('write_to_file')).toBe(false);
      expect(shouldPassthrough('execute_command')).toBe(false);
    });

    it('should return false for unknown tools', () => {
      expect(shouldPassthrough('unknown')).toBe(false);
    });
  });
});