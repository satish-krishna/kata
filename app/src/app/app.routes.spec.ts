import { routes } from './app.routes';

describe('routes', () => {
  it('maps the Workbench screens the AI-SDLC home and the mode choice', () => {
    expect(routes.map((r) => r.path)).toEqual(['', 'library', 'sdlc', 'mode']);
  });
});
