import { routes } from './app.routes';

describe('routes', () => {
  it('maps the Workbench screens and the mode choice', () => {
    expect(routes.map((r) => r.path)).toEqual(['', 'library', 'mode']);
  });
});
