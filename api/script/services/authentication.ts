import * as dotenv from 'dotenv';
import { Request, Response, Router } from "express";
import * as jwt from "jsonwebtoken";
import { AwsMongoStorage } from '../infrastructure/aws-mongodb';
dotenv.config();

export interface AuthenticationConfig {
  jwtSecret?: string;
  storage?: AwsMongoStorage;
}

export class Authentication {
  private _jwtSecret: string;
  private _storage: AwsMongoStorage;
  constructor(config?: AuthenticationConfig) {
    this._jwtSecret = config?.jwtSecret || process.env.JWT_SECRET || "ontol-jwt-secret-key";
    this._storage = config?.storage || new AwsMongoStorage();
  }

  /**
   * HTTP 요청의 인증을 처리합니다.
   * @param req 요청 객체   
   * @param res 응답 객체
   * @param next 다음 미들웨어 함수
   * @returns 
   */
  public authenticate(req: Request, res: Response, next: (err?: Error) => void) {
    // HTTP 요청 헤더에서 인증 토큰을 추출합니다.
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send("인증 토큰이 필요합니다.");
    }

    const token = authHeader.substring(7);
    
    try {
      // 인증 토큰의 유효성을 검증합니다.
      const decoded = jwt.verify(token, this._jwtSecret) as { sub: string };
      
      if (!decoded.sub) {
        return res.status(401).send("유효하지 않은 토큰입니다.");
      }
      
      // 토큰이 유효하면 디코딩된 정보에서 sub 필드를 확인합니다.
      // 이 정보를 req.user 객체에 저장하여 후속 미들웨어나 라우트 핸들러에서 사용할 수 있게 합니다.
      req.user = { id: decoded.sub };
      next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).send("만료된 토큰입니다.");
      } else if (error.name === "JsonWebTokenError") {
        return res.status(401).send("유효하지 않은 토큰입니다.");
      } else {
        res.status(500).send("서버 오류가 발생했습니다.");
        next(error);
      }
    }
  }

  /**
   * 인증 토큰을 검증하는 라우터를 반환합니다.
   * @returns 인증 토큰을 검증하는 라우터
   */
  public getRouter(): Router {
    const router: Router = Router();
    
    router.get("/authenticated", this.authenticate.bind(this), (req: Request, res: Response): any => {
      res.send({ authenticated: true });
    });

    return router;
  }
}