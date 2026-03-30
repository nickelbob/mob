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
    killInstance: string;
    dismissInstance: string;
    collapseGroup: string;
    expandGroup: string;
    openSettings: string;
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
    notificationSound: boolean;
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
    jumpToInstance1: 'Alt+Digit1',
    jumpToInstance2: 'Alt+Digit2',
    jumpToInstance3: 'Alt+Digit3',
    jumpToInstance4: 'Alt+Digit4',
    jumpToInstance5: 'Alt+Digit5',
    jumpToInstance6: 'Alt+Digit6',
    jumpToInstance7: 'Alt+Digit7',
    jumpToInstance8: 'Alt+Digit8',
    jumpToInstance9: 'Alt+Digit9',
    resumeInstance: 'Alt+KeyR',
    killInstance: 'Alt+KeyW',
    dismissInstance: 'Alt+KeyX',
    collapseGroup: 'Alt+Shift+ArrowLeft',
    expandGroup: 'Alt+Shift+ArrowRight',
    openSettings: 'Alt+Comma',
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
    notificationSound: false,
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
