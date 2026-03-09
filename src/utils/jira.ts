import type { State } from '../types/jira';
import { migrateJiraState } from '../services/migration';
import { JiraApiClient } from '../services/jira';

export const JIRA_PROPERTY_KEY = 'com.yrambler2001.jira-tracker';

export const parseState = async (state: string | null, client: JiraApiClient): Promise<State> => {
  let parsed: State | null = null;
  try {
    if (state) {
      parsed = JSON.parse(state);
      const { migratedData, isMigrated } = migrateJiraState(parsed as State);
      if (isMigrated) {
        await client.setUserProperty(JIRA_PROPERTY_KEY, stringifyState(migratedData));
        return migratedData;
      }
    }
  } catch (e) {
    console.error('Could not parse state from Jira user property', e);
  }
  if (!parsed || typeof parsed !== 'object') parsed = { trackedTickets: {}, starredTickets: [] };
  return parsed as State;
};

export const stringifyState = (state: State): string => {
  const stateToStore = {
    trackedTickets: state.trackedTickets,
    starredTickets: state.starredTickets,
    version: state.version,
  };
  return JSON.stringify(stateToStore);
};

interface AtlassianDocumentNode {
  type?: string;
  text?: string;
  attrs?: {
    url?: string;
  };
  content?: AtlassianDocumentNode[];
}

export const extractTextFromAtlassianDocumentFormat = (node: unknown): string => {
  if (!node || typeof node !== 'object') return '';
  const documentNode = node as AtlassianDocumentNode;

  switch (documentNode.type) {
    case 'text':
      return documentNode.text || '';
    case 'inlineCard':
      return documentNode.attrs?.url || '';
    case 'paragraph':
    case 'doc':
    case 'blockquote':
    case 'heading':
      return (documentNode.content || []).map(extractTextFromAtlassianDocumentFormat).join('');
    case 'bulletList':
    case 'orderedList':
      return (documentNode.content || []).map(extractTextFromAtlassianDocumentFormat).join('\n');
    case 'listItem':
      return `- ${(documentNode.content || []).map(extractTextFromAtlassianDocumentFormat).join('')}\n`;
    default:
      return (documentNode.content || []).map(extractTextFromAtlassianDocumentFormat).join('');
  }
};
