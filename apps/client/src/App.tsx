import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import { BootScreen } from "./screens/BootScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { ForgotPasswordScreen, ResetPasswordScreen, VerifyEmailScreen } from "./screens/RecoveryScreens";
import { MainMenu } from "./screens/MainMenu";
import { TrainingScreen } from "./screens/TrainingScreen";

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "checking") return null;
  return status === "authenticated" ? <>{children}</> : <Navigate to="/login" replace />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "checking") return null;
  return status === "anonymous" ? <>{children}</> : <Navigate to="/menu" replace />;
}

export function App() {
  const location = useLocation();
  return (
    <Routes location={location} key={location.pathname}>
      <Route path="/" element={<BootScreen />} />
      <Route path="/login" element={<GuestOnly><LoginScreen /></GuestOnly>} />
      <Route path="/cadastro" element={<GuestOnly><RegisterScreen /></GuestOnly>} />
      <Route path="/recuperar-senha" element={<ForgotPasswordScreen />} />
      <Route path="/redefinir-senha" element={<ResetPasswordScreen />} />
      <Route path="/verificar-email" element={<VerifyEmailScreen />} />
      <Route path="/menu" element={<RequireAuth><MainMenu /></RequireAuth>} />
      <Route path="/treinamento" element={<RequireAuth><TrainingScreen /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
