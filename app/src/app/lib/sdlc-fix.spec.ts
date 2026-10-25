import { fullPipelineIdea } from './sdlc-fix';

describe('fullPipelineIdea', () => {
  it('is the title, a blank line and the first paragraph under Problem', () => {
    const md = '---\ntitle: Stop the double refund\nstatus: draft\n---\n\n## Problem\n\nA refund is paid twice\nwhen the button is clicked twice.\n\nIt happens weekly.\n\n## Fix\n\nDisable the button.\n';
    expect(fullPipelineIdea(md)).toBe('Stop the double refund\n\nA refund is paid twice\nwhen the button is clicked twice.');
  });

  it('is the title alone when there is no Problem section', () => {
    const md = '---\ntitle: Stop the double refund\n---\n\n## Fix\n\nDisable the button.\n';
    expect(fullPipelineIdea(md)).toBe('Stop the double refund');
  });

  it('reads CRLF as LF', () => {
    const md = '---\r\ntitle: Stop the double refund\r\n---\r\n\r\n## Problem\r\n\r\nA refund is paid twice.\r\n\r\nIt happens weekly.\r\n';
    expect(fullPipelineIdea(md)).toBe('Stop the double refund\n\nA refund is paid twice.');
  });
});
