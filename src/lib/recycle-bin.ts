import { db } from './firebase';
import { collection, addDoc, deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Post, Board, OperationType } from '../types';
import { handleFirestoreError } from './error-handler';
import { deletePostImage } from './upload-helper';

/**
 * Moves a post to the recycle bin without deleting its images from Google Drive.
 * The images will only be permanently deleted when the user empties the trash.
 */
export async function movePostToRecycleBin(post: Post, boardName: string): Promise<void> {
  try {
    await addDoc(collection(db, 'recycle_bin'), {
      type: 'post',
      deletedAt: serverTimestamp(),
      deletedFrom: `لوحة: ${boardName}`,
      data: {
        post
      }
    });
    await deleteDoc(doc(db, 'posts', post.id));
  } catch (err) {
    console.error('Error moving post to recycle bin:', err);
    handleFirestoreError(err, OperationType.WRITE, 'recycle_bin');
    throw err;
  }
}

/**
 * Moves a prompt text and its custom builder options to the recycle bin.
 */
export async function movePromptToRecycleBin(promptText: string, options: any): Promise<void> {
  try {
    await addDoc(collection(db, 'recycle_bin'), {
      type: 'prompt',
      deletedAt: serverTimestamp(),
      deletedFrom: 'صانع البرومبت',
      data: {
        promptText,
        options
      }
    });
  } catch (err) {
    console.error('Error moving prompt to recycle bin:', err);
    handleFirestoreError(err, OperationType.WRITE, 'recycle_bin');
    throw err;
  }
}

/**
 * Moves an entire board and all of its associated posts to the recycle bin.
 */
export async function moveBoardToRecycleBin(board: Board, posts: Post[]): Promise<void> {
  try {
    await addDoc(collection(db, 'recycle_bin'), {
      type: 'board',
      deletedAt: serverTimestamp(),
      deletedFrom: 'اللوحات الرئيسية',
      data: {
        board,
        posts
      }
    });
    
    // Delete posts of the board
    for (const post of posts) {
      await deleteDoc(doc(db, 'posts', post.id));
    }
    
    // Delete board itself
    await deleteDoc(doc(db, 'boards', board.id));
  } catch (err) {
    console.error('Error moving board to recycle bin:', err);
    handleFirestoreError(err, OperationType.WRITE, 'recycle_bin');
    throw err;
  }
}

/**
 * Restores a recycle bin item back to its original collection or state.
 */
export async function restoreRecycleBinItem(item: any): Promise<void> {
  try {
    if (item.type === 'post') {
      const post = item.data.post;
      // Re-create the post document
      await setDoc(doc(db, 'posts', post.id), post);
    } else if (item.type === 'prompt') {
      // For prompt, save to localStorage so that the PromptBuilder can catch it
      localStorage.setItem('restored_prompt_text', item.data.promptText);
      if (item.data.options) {
        localStorage.setItem('restored_prompt_options', JSON.stringify(item.data.options));
      }
      // Dispatch a storage event to alert active tabs/components instantly
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'restored_prompt_text',
        newValue: item.data.promptText
      }));
    } else if (item.type === 'board') {
      const board = item.data.board;
      const posts = item.data.posts || [];
      // Re-create the board document
      await setDoc(doc(db, 'boards', board.id), board);
      // Re-create each post
      for (const post of posts) {
        await setDoc(doc(db, 'posts', post.id), post);
      }
    }
    // Delete from recycle bin collection
    await deleteDoc(doc(db, 'recycle_bin', item.id));
  } catch (err) {
    console.error('Error restoring item:', err);
    handleFirestoreError(err, OperationType.WRITE, 'recycle_bin_restore');
    throw err;
  }
}

/**
 * Permanently deletes a recycle bin item, cleaning up any referenced images in Google Drive.
 */
export async function deleteRecycleBinItemPermanently(item: any, accessToken?: string | null): Promise<void> {
  try {
    if (item.type === 'post') {
      const post = item.data.post;
      const urlsToDelete = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
      if (urlsToDelete.length > 0) {
        for (const url of urlsToDelete) {
          try {
            await deletePostImage(url, accessToken);
          } catch (err) {
            console.warn('[RecycleBin] Failed to delete image from Drive:', err);
          }
        }
      }
    } else if (item.type === 'board') {
      const posts = item.data.posts || [];
      for (const post of posts) {
        const urlsToDelete = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
        if (urlsToDelete.length > 0) {
          for (const url of urlsToDelete) {
            try {
              await deletePostImage(url, accessToken);
            } catch (err) {
              console.warn('[RecycleBin] Failed to delete board post image from Drive:', err);
            }
          }
        }
      }
    }
    // Delete document from recycle bin
    await deleteDoc(doc(db, 'recycle_bin', item.id));
  } catch (err) {
    console.error('Error permanently deleting item:', err);
    handleFirestoreError(err, OperationType.DELETE, 'recycle_bin_permanent');
    throw err;
  }
}

/**
 * Empties the entire recycle bin by permanently deleting all items.
 */
export async function emptyRecycleBin(items: any[], accessToken?: string | null): Promise<void> {
  try {
    for (const item of items) {
      await deleteRecycleBinItemPermanently(item, accessToken);
    }
  } catch (err) {
    console.error('Error emptying recycle bin:', err);
    throw err;
  }
}
