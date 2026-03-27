export interface Settings {
  shortcuts: {
    launchDialog: string;
    toggleSidebar: string;
    cycleInstanceDown: string;
    cycleInstanceUp: string;
    jumpToInstance1: string;
    jumpToInstance2: string;
    jumpToInstance3: string;
    jumpToInstance4: string;
    jumpToInstance5: string;
    jumpToInstance6: string;
    jumpToInstance7: string;
    jumpToInstance8: string;
    jumpToInstance9: string;
    resumeInstance: string;
  };
  launch: {
    cwd: string;
    model: string;
    permissionMode: string;
    autoName: boolean;
  };
  terminal: {
    fontSize: number;
    cursorStyle: 'block' | 'underline' | 'bar';
    scrollbackLines: number;
  };
  general: {
    sidebarCollapsed: boolean;
    maxCachedTerminals: number;
    staleThresholdSecs: number;
    notifications: boolean;
  };
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  shortcuts: {
    launchDialog: 'Alt+KeyN',
    toggleSidebar: 'Alt+KeyB',
    cycleInstanceDown: 'Alt+ArrowDown',
    cycleInstanceUp: 'Alt+ArrowUp',
    jumpToInstance1: 'Mod+Digit1',
    jumpToInstance2: 'Mod+Digit2',
    jumpToInstance3: 'Mod+Digit3',
    jumpToInstance4: 'Mod+Digit4',
    jumpToInstance5: 'Mod+Digit5',
    jumpToInstance6: 'Mod+Digit6',
    jumpToInstance7: 'Mod+Digit7',
    jumpToInstance8: 'Mod+Digit8',
    jumpToInstance9: 'Mod+Digit9',
    resumeInstance: 'Alt+KeyR',
  },
  launch: {
    cwd: '',
    model: '',
    permissionMode: '',
    autoName: true,
  },
  terminal: {
    fontSize: 14,
    cursorStyle: 'block',
    scrollbackLines: 5000,
  },
  general: {
    sidebarCollapsed: false,
    maxCachedTerminals: 20,
    staleThresholdSecs: 30,
    notifications: true,
  },
  jira: {
    baseUrl: '',
    email: '',
    apiToken: '',
  },
};

/** Deep merge a partial settings object with defaults, ensuring all keys exist. */
export function mergeWithDefaults(partial: Record<string, any>): Settings {
  const result: any = structuredClone(DEFAULT_SETTINGS);
  for (const section of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (partial[section] && typeof partial[section] === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS[section])) {
        if (key in partial[section]) {
          result[section][key] = partial[section][key];
        }
      }
    }
  }
  return result as Settings;
}
