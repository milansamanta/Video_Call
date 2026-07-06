FROM node:20-alpine AS build-stage

ENV VITE_API_URI=https://backend-image-w2bv.onrender.com

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# COPY --from=build-stage /app/dist /usr/share/nginx/htm
RUN npm install -g serve

EXPOSE 80
CMD ["sh", "-c", "serve -s dist -l 80"]
# CMD ["nginx", "-g", "daemon off;"]