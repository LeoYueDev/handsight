export interface ConversationEvent {
  id?: number;
  timestamp: number;
  role: "user" | "assistant";
  content: string;
  project?: string;
}

export interface FileEvent {
  id?: number;
  timestamp: number;
  path: string;
  action: "create" | "modify" | "delete";
  project?: string;
}

export interface Memory {
  id?: number;
  timestamp: number;
  type: "preference" | "pattern" | "decision" | "context";
  content: string;
  confidence: number;
  source: string;
  project?: string;
}

export interface UserProfile {
  preferences: Record<string, string>;
  patterns: Record<string, string>;
  recentContext: {
    area: string;
    files: string[];
    changes: string[];
  }[];
  lastUpdated: number;
}
