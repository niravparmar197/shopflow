// Every migration, oldest first. The webpack bundle has no .ts files for a
// glob to find, so add each new migration class here when you generate it.
import { InitInventory1791891961260 } from './1791891961260-InitInventory';

export const MIGRATIONS = [InitInventory1791891961260];
