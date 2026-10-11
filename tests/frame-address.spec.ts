import { describe, expect, it } from 'vitest'
import { fileAddressFor, frameAddress } from '../src/client/TabBody.tsx'

/**
 * The frame address is the one piece of client behaviour that decides whether the
 * workbench opens at all: a cookie inside a cross-origin frame may be dropped, so
 * the session must travel in the path. The project directory the host asked for
 * must survive that rewrite, or the tab would open on the project list instead of
 * the canvas.
 */
const token = 'a'.repeat(64)

describe('the frame address', () => {
  it('moves the session token into the path', () => {
    expect(frameAddress(`http://127.0.0.1:51234/?filmAccess=${token}`)).toBe(`http://127.0.0.1:51234/s/${token}/`)
  })

  it('keeps the workspace, so the app can open its canvas, and names the host origin', () => {
    const workspace = 'C:\\Users\\me\\项目\\demo'
    const address = frameAddress(`http://127.0.0.1:51234/?filmAccess=${token}&filmWorkspace=${encodeURIComponent(workspace)}`, 'http://127.0.0.1:58574')
    expect(new URL(address).pathname).toBe(`/s/${token}/`)
    expect(new URL(address).searchParams.get('filmWorkspace')).toBe(workspace)
    expect(new URL(address).searchParams.get('filmHost')).toBe('http://127.0.0.1:58574')
    expect(new URL(address).searchParams.has('filmAccess')).toBe(false)
  })

  it('names the conversation the tab belongs to, so writing uses its current model', () => {
    const address = frameAddress(`http://127.0.0.1:51234/?filmAccess=${token}`, 'http://127.0.0.1:58574', 'session-42')
    expect(new URL(address).searchParams.get('filmSession')).toBe('session-42')
    expect(new URL(frameAddress(`http://127.0.0.1:51234/?filmAccess=${token}`)).searchParams.has('filmSession')).toBe(false)
  })

  it('names a workspace file the way the Host preview opens it', () => {
    expect(fileAddressFor('s1', 'C:\\Users\\me\\ws', 'C:\\Users\\me\\ws\\VibeDev Film\\剧本 #1.md'))
      .toBe(`dsh-resource://file/session/s1/VibeDev%20Film/${encodeURIComponent('剧本 #1.md')}`)
    expect(fileAddressFor('s1', 'C:\\Users\\me\\ws', 'D:\\other\\a.md')).toBe('dsh-resource://file/session/s1/D:/other/a.md')
  })

  it('keeps a fragment the host may have added', () => {
    expect(frameAddress(`http://127.0.0.1:51234/?filmAccess=${token}#/workspace`)).toBe(
      `http://127.0.0.1:51234/s/${token}/#/workspace`,
    )
  })

  it('leaves a link without a usable token alone', () => {
    expect(frameAddress('http://127.0.0.1:51234/')).toBe('http://127.0.0.1:51234/')
    expect(frameAddress('http://127.0.0.1:51234/?filmAccess=short')).toBe('http://127.0.0.1:51234/?filmAccess=short')
    expect(frameAddress('not a url')).toBe('not a url')
  })
})
