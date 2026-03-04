import type { State, Settings } from '../types/jira';
import { randomUUID } from '../utils/uuid';

type UnknownRecord = Record<string, unknown>;

interface Migration {
  version: number;
  migrate: (data: UnknownRecord) => UnknownRecord;
}

const toRecord = (value: unknown): UnknownRecord => (value && typeof value === 'object' ? (value as UnknownRecord) : {});
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asBoolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : false);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const localStorageMigrations: Migration[] = [
  {
    version: 1,
    migrate: (data: UnknownRecord) => ({
      ...data,
    }),
  },
  {
    version: 2,
    migrate: (data: UnknownRecord) => {
      const oldData = toRecord(data);
      const newId = randomUUID();
      return {
        accounts: [
          {
            id: newId,
            jiraSubdomain: asString(oldData.jiraSubdomain),
            email: asString(oldData.email),
            jiraToken: asString(oldData.jiraToken),
          },
        ],
        activeAccount: newId,
        displayOnNewLine: asBoolean(oldData.displayOnNewLine),
        isHeaderNonFloating: asBoolean(oldData.isHeaderNonFloating),
        theme: asString(oldData.theme),
        plannedHours: 0,
      };
    },
  },
  {
    version: 3,
    migrate: (data: UnknownRecord) => {
      const plannedHours = asNumber(data.plannedHours) ?? 0;
      return {
        ...data,
        plannedHours,
      };
    },
  },
];

const jiraStateMigrations: Migration[] = [
  {
    version: 1,
    migrate: (data: UnknownRecord) => ({
      ...data,
      trackedTickets: data.trackedTickets || {},
      starredTickets: data.starredTickets || [],
    }),
  },
];

const LATEST_LOCAL_STORAGE_VERSION = localStorageMigrations.length ? Math.max(...localStorageMigrations.map((m) => m.version)) : 0;
const LATEST_JIRA_STATE_VERSION = jiraStateMigrations.length ? Math.max(...jiraStateMigrations.map((m) => m.version)) : 0;

function migrate(data: unknown, migrations: Migration[], latestVersion: number): { migratedData: UnknownRecord; isMigrated: boolean } {
  const normalizedData = toRecord(data);
  const originalVersion = asNumber(normalizedData.version) ?? 0;
  let currentVersion = originalVersion;
  let migratedData: UnknownRecord = { ...normalizedData };

  while (currentVersion < latestVersion) {
    const nextVersion = currentVersion + 1;
    const migration = migrations.find((m) => m.version === nextVersion);
    if (migration) {
      migratedData = migration.migrate(migratedData);
      migratedData = { ...migratedData, version: nextVersion };
    }
    currentVersion = nextVersion;
  }

  const finalVersion = asNumber(migratedData.version) ?? 0;
  return { migratedData, isMigrated: originalVersion !== finalVersion };
}

export function migrateLocalStorage(data: Settings): {
  migratedData: Settings;
  isMigrated: boolean;
} {
  const result = migrate(data, localStorageMigrations, LATEST_LOCAL_STORAGE_VERSION);
  return {
    migratedData: result.migratedData as Settings,
    isMigrated: result.isMigrated,
  };
}

export function migrateJiraState(data: State): {
  migratedData: State;
  isMigrated: boolean;
} {
  const result = migrate(data, jiraStateMigrations, LATEST_JIRA_STATE_VERSION);
  return {
    migratedData: result.migratedData as State,
    isMigrated: result.isMigrated,
  };
}
