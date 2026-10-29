import { routes } from './app.routes';

describe('routes', () => {
  it('maps the Workbench screens the AI-SDLC home, the context screen, the change page and the mode choice', () => {
    expect(routes.map((r) => r.path)).toEqual(['', 'library', 'sdlc', 'sdlc/:system/context/:repo', 'sdlc/:system/:change', 'mode']);
  });
});
