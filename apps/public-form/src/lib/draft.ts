import { createContext, useContext } from 'react'

/**
 * The current draft id, for components that need to talk to the server mid-form.
 *
 * Only the file input needs it, and threading a prop through every renderer
 * branch to reach one leaf would touch code that has nothing to do with uploads.
 */
export const DraftContext = createContext<string | null>(null)

export function useDraftId(): string | null {
  return useContext(DraftContext)
}
