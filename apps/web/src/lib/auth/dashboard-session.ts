import type { CurrentUserDto } from "@doxahq/contracts"

export interface DashboardSessionUser {
  id: string
  name: string | null
  email: string | null
  image: string | null
}

export interface DashboardSession {
  user: DashboardSessionUser
}

export function createDashboardSession(user: CurrentUserDto): DashboardSession {
  return {
    user: {
      id: user.id,
      name: null,
      email: user.email,
      image: null,
    },
  }
}

export function createDevDashboardSession(userId: string): DashboardSession {
  return {
    user: {
      id: userId,
      name: "Dev User",
      email: userId,
      image: null,
    },
  }
}
