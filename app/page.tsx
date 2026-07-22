import { auth } from '@/auth'
import Landing from '@/components/Landing'

export default async function Page() {
  const session = await auth()
  return <Landing signedIn={!!session?.user} />
}
