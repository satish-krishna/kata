import { routes } from './app.routes';

describe('routes', () => {
  it('maps the two Workbench screens', () => {
    expect(routes.map((r) => r.path)).toEqual(['', 'library']);
  });
});
