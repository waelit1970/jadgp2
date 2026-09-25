import { Timestamp } from 'firebase/firestore';

export interface SubBoard {
  id: string;
  name: string;
}

export interface Post {
  id: string;
  text: string;
  imageUrl?: string;
  imageUrls?: string[];
  imageModels?: string[];
  imageCaptions?: string[];
  boardId: string;
  subBoardId?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  authorId: string;
  authorEmail: string;
  isPinned?: boolean;
  createdAtMillis?: number;
  fileNames?: string[];
  fileTypes?: string[];
  fileSizes?: string[];
  customOrder?: number;
}

export interface Board {
  id: string;
  name: string;
  order: number;
  createdAt: Timestamp;
  locked?: boolean;
  hidden?: boolean;
  subBoards?: SubBoard[];
}

export interface GlobalSettings {
  ownerEmail: string;
  trialDays: number;
  allFree: boolean;
  vaultPasswordHash?: string;
}

export interface License {
  email: string;
  activationCode: string;
  activated: boolean;
  trialStartDate: number;
  expiryDate?: number | null;
  activatedAt?: number | null;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export interface GeneratedImage {
  id: string;
  title: string;
  imageUrl: string | null;
  status: 'pending' | 'loading' | 'completed' | 'failed';
  error?: string;
}

