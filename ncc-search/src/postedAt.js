// The `posted_at` rule lives in shared/ because the nsite edition's browser
// crawler computes the same dates (see shared/postedAt.js). Re-exported here
// so every existing backend import keeps working unchanged.
export { postedAtOf } from '../shared/postedAt.js';
