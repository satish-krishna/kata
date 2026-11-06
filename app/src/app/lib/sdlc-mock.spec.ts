import { BUILD_REPOS_OF, MOCK_BUILD_CHANGE, SdlcMock } from './sdlc-mock';

describe('SdlcMock repositories', () => {
  it('lists only commerce-core everywhere in the sessions demo', () => {
    const mock = new SdlcMock(false, 'sessions', 2);
    expect(mock.buildRepos(MOCK_BUILD_CHANGE)).toEqual(['commerce-core']);
    expect(mock.buildStatus(MOCK_BUILD_CHANGE).repos.map((r) => r.repo)).toEqual(['commerce-core']);
    expect(mock.checksView(MOCK_BUILD_CHANGE).map((r) => r.repo)).toEqual(['commerce-core']);
  });

  it('never mutates the module-level repositories of the build change', () => {
    const before = [...BUILD_REPOS_OF[MOCK_BUILD_CHANGE]];
    new SdlcMock(false, 'sessions', 2);
    expect(BUILD_REPOS_OF[MOCK_BUILD_CHANGE]).toEqual(before);
    expect(before).toEqual(['commerce-core', 'customer-portal']);
  });

  it('keeps the default repositories in any other demo', () => {
    const mock = new SdlcMock();
    expect(mock.buildRepos(MOCK_BUILD_CHANGE)).toEqual(['commerce-core', 'customer-portal']);
    expect(mock.buildStatus(MOCK_BUILD_CHANGE).repos.map((r) => r.repo)).toEqual(['commerce-core', 'customer-portal']);
    expect(mock.checksView(MOCK_BUILD_CHANGE).map((r) => r.repo)).toEqual(['commerce-core', 'customer-portal']);
  });
});
