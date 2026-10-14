import { migrationFileClassNames } from '../../../../../test/helpers/migrations';
import { MIGRATIONS } from '.';

describe('MIGRATIONS', () => {
  it('lists every migration file, oldest first', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(
      migrationFileClassNames(__dirname),
    );
  });
});
